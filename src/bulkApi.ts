import { Agent, ProxyAgent, type Dispatcher } from "undici";

import { normalizeProxyUrlInput } from "./network";
import type { ActionEnvelope, ExchangeSymbolInfo, FullAccountState } from "./types";

interface ApiResponse {
  status: string;
  response?: {
    type: string;
    data?: {
      statuses?: Array<Record<string, unknown>>;
    };
  };
}

export class BulkApiClient {
  private readonly dispatcher: Dispatcher;

  constructor(
    private readonly baseUrl: string,
    proxyUrl?: string | null
  ) {
    const normalizedProxyUrl = normalizeProxyUrlInput(proxyUrl);
    this.dispatcher = normalizedProxyUrl
      ? new ProxyAgent(normalizedProxyUrl)
      : new Agent();
  }

  async getExchangeInfo(): Promise<ExchangeSymbolInfo[]> {
    const response = await this.request(`${this.baseUrl}/exchangeInfo`, undefined, "exchangeInfo");
    return (await this.parseJson(response)) as ExchangeSymbolInfo[];
  }

  async getFullAccount(user: string): Promise<FullAccountState> {
    const response = await this.request(`${this.baseUrl}/account`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        type: "fullAccount",
        user
      })
    }, `account ${user}`);

    const payload = (await this.parseJson(response)) as Array<{ fullAccount: FullAccountState }>;

    if (!Array.isArray(payload) || payload.length === 0 || !payload[0]?.fullAccount) {
      throw new Error(`Unexpected account payload: ${JSON.stringify(payload)}`);
    }

    return payload[0].fullAccount;
  }

  async submit(envelope: ActionEnvelope): Promise<ApiResponse> {
    const response = await this.request(`${this.baseUrl}/order`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(envelope)
    }, "order");

    return (await this.parseJson(response)) as ApiResponse;
  }

  async getReferencePrice(symbol: string): Promise<number> {
    const pythSymbol = toPythSymbol(symbol);
    const now = Math.floor(Date.now() / 1000);
    const response = await this.request(
      `https://history.pyth-lazer.dourolabs.app/v1/real_time/history?symbol=${encodeURIComponent(pythSymbol)}&resolution=1&from=${now - 60}&to=${now}`
      , undefined, `reference price ${symbol}`);

    const payload = (await this.parseJson(response)) as {
      c?: number[];
    };

    const close = payload.c?.at(-1);

    if (!close || !Number.isFinite(close)) {
      throw new Error(`Failed to get reference price for ${symbol}: ${JSON.stringify(payload)}`);
    }

    return close;
  }

  private async request(url: string, init?: RequestInit, context?: string): Promise<Response> {
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await fetch(url, {
          ...init,
          signal: AbortSignal.timeout(20_000),
          dispatcher: this.dispatcher
        } as RequestInit & { dispatcher: Dispatcher });

        if (response.ok || !shouldRetryStatus(response.status) || attempt === maxAttempts) {
          return response;
        }

        await sleep(750 * attempt);
      } catch (error) {
        if (attempt === maxAttempts) {
          const label = context ?? url;
          throw new Error(`${label} request failed: ${formatFetchError(error)}`);
        }

        await sleep(750 * attempt);
      }
    }

    throw new Error(`${context ?? url} request failed: retry budget exhausted`);
  }

  private async parseJson(response: Response): Promise<unknown> {
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new Error(`Failed to parse JSON response: ${text}`);
    }
  }
}

function shouldRetryStatus(status: number): boolean {
  return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

function formatFetchError(error: unknown): string {
  if (error instanceof Error) {
    const causeText =
      error.cause && typeof error.cause === "object" && "message" in error.cause
        ? String((error.cause as { message?: unknown }).message)
        : undefined;

    return causeText ? `${error.message} (${causeText})` : error.message;
  }

  return String(error);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function toPythSymbol(symbol: string): string {
  const normalized = symbol.toUpperCase();
  const mapping: Record<string, string> = {
    "BTC-USD": "Crypto.BTC/USD",
    "ETH-USD": "Crypto.ETH/USD",
    "SOL-USD": "Crypto.SOL/USD",
    "XRP-USD": "Crypto.XRP/USD",
    "GOLD-USD": "Metal.XAU/USD"
  };

  const pythSymbol = mapping[normalized];

  if (!pythSymbol) {
    throw new Error(`No price feed mapping for ${symbol}`);
  }

  return pythSymbol;
}

export function extractStatuses(payload: ApiResponse): Array<Record<string, unknown>> {
  return payload.response?.data?.statuses ?? [];
}

export function ensureAcceptedStatuses(payload: ApiResponse, context: string): Array<Record<string, unknown>> {
  if (payload.status !== "ok") {
    throw new Error(`${context} failed: ${JSON.stringify(payload)}`);
  }

  const statuses = extractStatuses(payload);
  const rejected = statuses.filter((entry) => {
    const [statusName] = Object.keys(entry);
    return ![
      "ack",
      "resting",
      "working",
      "filled",
      "partiallyFilled",
      "cancelled",
      "deposit",
      "agentWallet"
    ].includes(statusName);
  });

  if (rejected.length > 0) {
    throw new Error(`${context} rejected: ${JSON.stringify(rejected)}`);
  }

  return statuses;
}
