import { Agent, ProxyAgent, type Dispatcher } from "undici";

import { normalizeProxyUrlInput } from "./network";

const AURA_BASE_URL = "https://early.bulk.trade";
const AURA_LEADERBOARD_PATH = "/api/aura/v1/aura/predeposit/leaderboard";
const AURA_WALLET_PATH = "/api/aura/v1/aura/wallet/";
export const AURA_SEARCH_PARAMS = ["search", "query", "address", "wallet", "wallet_address"] as const;
const RETRY_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface AuraCheckResult {
  found: boolean;
  address: string;
  rank: number | null;
  aura: number | null;
  referrals: number | null;
  others: number | null;
  matchedBy: string | null;
  sourceUrl: string;
  raw?: Record<string, unknown>;
}

export async function checkPredepositAura(address: string, proxyUrl?: string | null): Promise<AuraCheckResult> {
  const normalizedProxy = normalizeProxyUrlInput(proxyUrl);
  const dispatcher: Dispatcher = normalizedProxy ? new ProxyAgent(normalizedProxy) : new Agent();
  let lastUrl = "";
  let lastPayload: unknown;

  try {
    const walletUrl = buildAuraWalletUrl(address);
    lastUrl = walletUrl;
    lastPayload = await requestJson(walletUrl, dispatcher);

    const walletResult = parseAuraPayload(address, lastPayload, walletUrl, "wallet");
    if (walletResult.found) {
      return walletResult;
    }

    for (const searchParam of AURA_SEARCH_PARAMS) {
      const url = buildAuraLeaderboardUrl(searchParam, address);
      lastUrl = url;
      lastPayload = await requestJson(url, dispatcher);

      const parsed = parseAuraPayload(address, lastPayload, url, searchParam);
      if (parsed.found) {
        return parsed;
      }
    }

    return {
      found: false,
      address,
      rank: null,
      aura: null,
      referrals: null,
      others: null,
      matchedBy: null,
      sourceUrl: lastUrl,
      raw: summarizePayload(lastPayload)
    };
  } finally {
    await dispatcher.close();
  }
}

export function buildAuraWalletUrl(address: string): string {
  return new URL(`${AURA_WALLET_PATH}${encodeURIComponent(address)}`, AURA_BASE_URL).toString();
}

export function buildAuraLeaderboardUrl(searchParam: string, address: string): string {
  const url = new URL(AURA_LEADERBOARD_PATH, AURA_BASE_URL);
  url.searchParams.set("page", "1");
  url.searchParams.set("page_size", "5");
  url.searchParams.set(searchParam, address);
  return url.toString();
}

export function parseAuraPayload(address: string, payload: unknown, sourceUrl: string, matchedBy: string): AuraCheckResult {
  const exactRow = findExactAddressRow(payload, address);
  if (exactRow) {
    return buildResult(address, sourceUrl, exactRow, matchedBy);
  }

  const singleRow = findSingleSearchResultRow(payload);
  if (singleRow) {
    return buildResult(address, sourceUrl, singleRow, `${matchedBy}:single-result`);
  }

  return {
    found: false,
    address,
    rank: null,
    aura: null,
    referrals: null,
    others: null,
    matchedBy: null,
    sourceUrl,
    raw: summarizePayload(payload)
  };
}

async function requestJson(url: string, dispatcher: Dispatcher): Promise<unknown> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        dispatcher,
        headers: {
          accept: "application/json, text/plain, */*",
          "accept-language": "en-US,en;q=0.9",
          referer: "https://early.bulk.trade/deposit",
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36"
        },
        signal: AbortSignal.timeout(20_000)
      } as RequestInit & { dispatcher: Dispatcher });

      const text = await response.text();

      if (!response.ok) {
        if (RETRY_STATUS_CODES.has(response.status) && attempt < 3) {
          await sleep(800 * attempt);
          continue;
        }

        throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
      }

      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error(`Invalid JSON: ${text.slice(0, 500)}`);
      }
    } catch (error) {
      lastError = error;

      if (attempt < 3 && isRetryableError(error)) {
        await sleep(800 * attempt);
        continue;
      }

      break;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function findExactAddressRow(payload: unknown, address: string): Record<string, unknown> | null {
  const normalizedAddress = address.toLowerCase();

  for (const row of collectObjects(payload)) {
    for (const value of Object.values(row)) {
      if (typeof value === "string" && value.toLowerCase() === normalizedAddress) {
        return row;
      }
    }
  }

  return null;
}

function findSingleSearchResultRow(payload: unknown): Record<string, unknown> | null {
  const arrays = collectArrays(payload)
    .filter((items): items is Array<Record<string, unknown>> => (
      items.length === 1 &&
      typeof items[0] === "object" &&
      items[0] !== null &&
      !Array.isArray(items[0])
    ));

  const auraLike = arrays.find(([row]) => extractAura(row) !== null || extractRank(row) !== null);
  return auraLike?.[0] ?? null;
}

function buildResult(address: string, sourceUrl: string, row: Record<string, unknown>, matchedBy: string): AuraCheckResult {
  const aura = extractAura(row);
  const referrals = extractNumberByKeys(row, [
    "referrals",
    "referralsRewarded",
    "referrals_rewarded",
    "referralAura",
    "referral_aura",
    "referralPoints",
    "referral_points"
  ]);

  return {
    found: true,
    address,
    rank: extractRank(row),
    aura,
    referrals,
    others: extractNumberByKeys(row, ["others", "otherAura", "other_aura", "otherPoints", "other_points"]) ?? (
      aura !== null && referrals !== null ? Math.max(0, aura - referrals) : null
    ),
    matchedBy,
    sourceUrl,
    raw: row
  };
}

function extractRank(row: Record<string, unknown>): number | null {
  return extractNumberByKeys(row, ["rank", "waitlistRank", "waitlist_rank", "position", "place"]);
}

function extractAura(row: Record<string, unknown>): number | null {
  return extractNumberByKeys(row, ["aura", "points", "score", "totalAura", "total_aura", "auraPoints", "aura_points"]);
}

function extractNumberByKeys(row: Record<string, unknown>, keys: string[]): number | null {
  const normalizedKeys = new Set(keys.map((key) => key.toLowerCase()));

  for (const [key, value] of Object.entries(row)) {
    if (!normalizedKeys.has(key.toLowerCase())) {
      continue;
    }

    const parsed = parseNumericValue(value);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

function parseNumericValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function collectObjects(payload: unknown): Array<Record<string, unknown>> {
  const objects: Array<Record<string, unknown>> = [];
  const stack = [payload];

  while (stack.length > 0) {
    const current = stack.pop();

    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }

    if (current && typeof current === "object") {
      const row = current as Record<string, unknown>;
      objects.push(row);
      stack.push(...Object.values(row));
    }
  }

  return objects;
}

function collectArrays(payload: unknown): unknown[][] {
  const arrays: unknown[][] = [];
  const stack = [payload];

  while (stack.length > 0) {
    const current = stack.pop();

    if (Array.isArray(current)) {
      arrays.push(current);
      stack.push(...current);
      continue;
    }

    if (current && typeof current === "object") {
      stack.push(...Object.values(current as Record<string, unknown>));
    }
  }

  return arrays;
}

function summarizePayload(payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }

  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    summary[key] = Array.isArray(value) ? `array(${value.length})` : typeof value;
  }

  return summary;
}

function isRetryableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes("http 408") ||
    message.includes("http 425") ||
    message.includes("http 429") ||
    message.includes("http 500") ||
    message.includes("http 502") ||
    message.includes("http 503") ||
    message.includes("http 504") ||
    message.includes("fetch failed") ||
    message.includes("timeout") ||
    message.includes("socket")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
