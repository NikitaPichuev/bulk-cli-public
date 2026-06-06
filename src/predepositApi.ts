import childProcess from "child_process";
import fs from "fs";
import http from "http";
import path from "path";
import { WebSocket } from "undici";

const PREDEPOSIT_BASE_URL = "https://early.bulk.trade";

export interface PredepositTotals {
  total_wallets?: number;
  total_deposited_amount?: number;
  total_withdrawn_amount?: number;
  total_current_amount?: number;
}

export interface PredepositRow {
  rank?: number;
  aura_rank?: number;
  wallet?: string;
  deposited_amount?: number;
  withdrawn_amount?: number;
  current_amount?: number;
  aura?: number;
}

export interface PredepositLeaderboard {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  totals: PredepositTotals;
  rows: PredepositRow[];
}

interface ChromeTarget {
  webSocketDebuggerUrl?: string;
  type?: string;
}

interface CdpResponse {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

export async function fetchPredepositLeaderboard(page: number, pageSize: number): Promise<PredepositLeaderboard> {
  const url = buildPredepositUrl(page, pageSize);

  try {
    return normalizeLeaderboardPayload(await requestJsonDirect(url));
  } catch (error) {
    if (!isVercelBlocked(error)) {
      throw error;
    }

    return normalizeLeaderboardPayload(await requestJsonWithHiddenChrome(url));
  }
}

export async function fetchAllPredepositLeaderboard(pageSize: number): Promise<PredepositLeaderboard> {
  const firstPage = await fetchPredepositLeaderboard(1, pageSize);
  const rows = [...firstPage.rows];
  const effectivePageSize = firstPage.page_size || pageSize;

  for (let page = 2; page <= firstPage.total_pages; page += 1) {
    const nextPage = await fetchPredepositLeaderboard(page, effectivePageSize);
    rows.push(...nextPage.rows);
  }

  return {
    ...firstPage,
    page: 1,
    page_size: effectivePageSize,
    rows
  };
}

function buildPredepositUrl(page: number, pageSize: number): string {
  const url = new URL("/api/aura/v1/aura/predeposit/leaderboard", PREDEPOSIT_BASE_URL);
  url.searchParams.set("page", String(page));
  url.searchParams.set("page_size", String(pageSize));
  return url.toString();
}

async function requestJsonDirect(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json, text/plain, */*",
      referer: "https://early.bulk.trade/deposit",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36"
    },
    signal: AbortSignal.timeout(20_000)
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  return JSON.parse(text) as unknown;
}

async function requestJsonWithHiddenChrome(url: string): Promise<unknown> {
  const chromePath = findChromeExecutable();
  const port = 9222 + Math.floor(Math.random() * 1000);
  const profileDir = path.resolve(process.cwd(), ".predeposit-chrome-profile");
  fs.mkdirSync(profileDir, { recursive: true });

  const chrome = childProcess.spawn(chromePath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--headless=new",
    "--no-first-run",
    "--disable-default-apps",
    "https://early.bulk.trade/deposit"
  ], {
    detached: false,
    stdio: "ignore"
  });

  try {
    const wsUrl = await waitForDebuggerUrl(port);
    const client = await CdpClient.connect(wsUrl);

    try {
      await sleep(3_000);
      const payload = await client.evaluateJson(`
        (async () => {
          const response = await fetch(${JSON.stringify(url)}, {
            headers: { accept: "application/json, text/plain, */*" },
            credentials: "include"
          });
          const text = await response.text();
          if (!response.ok) {
            return { __error: "HTTP " + response.status + ": " + text.slice(0, 500) };
          }
          return JSON.parse(text);
        })()
      `);

      if (payload && typeof payload === "object" && "__error" in payload) {
        throw new Error(String((payload as { __error: unknown }).__error));
      }

      return payload;
    } finally {
      client.close();
    }
  } finally {
    chrome.kill();
  }
}

function normalizeLeaderboardPayload(payload: unknown): PredepositLeaderboard {
  if (!payload || typeof payload !== "object") {
    throw new Error("Predeposit response is not an object.");
  }

  const data = payload as Record<string, unknown>;
  const rows = Array.isArray(data.rows) ? data.rows.map(normalizeRow) : [];

  return {
    page: toNumber(data.page) ?? 1,
    page_size: toNumber(data.page_size) ?? rows.length,
    total: toNumber(data.total) ?? rows.length,
    total_pages: toNumber(data.total_pages) ?? 1,
    totals: typeof data.totals === "object" && data.totals ? data.totals as PredepositTotals : {},
    rows
  };
}

function normalizeRow(row: unknown): PredepositRow {
  if (!row || typeof row !== "object") {
    return {};
  }

  const data = row as Record<string, unknown>;

  return {
    rank: toNumber(data.rank),
    aura_rank: toNumber(data.aura_rank),
    wallet: typeof data.wallet === "string" ? data.wallet : undefined,
    deposited_amount: toNumber(data.deposited_amount),
    withdrawn_amount: toNumber(data.withdrawn_amount),
    current_amount: toNumber(data.current_amount),
    aura: toNumber(data.aura)
  };
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as CdpResponse;
      if (!message.id) {
        return;
      }

      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }

      this.pending.delete(message.id);
      message.error ? pending.reject(new Error(message.error.message ?? "Chrome DevTools error")) : pending.resolve(message.result);
    });
  }

  static async connect(wsUrl: string): Promise<CdpClient> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("Chrome DevTools websocket failed")), { once: true });
    });
    return new CdpClient(ws);
  }

  async evaluateJson(expression: string): Promise<unknown> {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    }) as { result?: { value?: unknown } };

    return result.result?.value;
  }

  close(): void {
    this.ws.close();
  }

  private send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(payload);
    });
  }
}

async function waitForDebuggerUrl(port: number): Promise<string> {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    try {
      const targets = await httpJson<ChromeTarget[]>(`http://127.0.0.1:${port}/json`);
      const target = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl) ?? targets[0];
      if (target?.webSocketDebuggerUrl) {
        return target.webSocketDebuggerUrl;
      }
    } catch {
      // Chrome is still starting.
    }

    await sleep(500);
  }

  throw new Error("Chrome DevTools endpoint did not start.");
}

function httpJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
        } catch (error) {
          reject(error);
        }
      });
    }).on("error", reject);
  });
}

function findChromeExecutable(): string {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe")
  ].filter(Boolean) as string[];

  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error("Chrome executable not found. Set CHROME_PATH.");
  }

  return found;
}

function isVercelBlocked(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Vercel Security Checkpoint") || message.includes("HTTP 429");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
