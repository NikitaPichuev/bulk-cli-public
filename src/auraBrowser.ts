import childProcess from "child_process";
import fs from "fs";
import http from "http";
import path from "path";
import { WebSocket } from "undici";

import { AURA_SEARCH_PARAMS, buildAuraLeaderboardUrl, buildAuraWalletUrl, parseAuraPayload, type AuraCheckResult } from "./auraApi";

interface ChromeTarget {
  webSocketDebuggerUrl?: string;
  type?: string;
  url?: string;
}

interface CdpResponse {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

export async function checkPredepositAuraWithChrome(addresses: string[]): Promise<AuraCheckResult[]> {
  const chromePath = findChromeExecutable();
  const port = 9222 + Math.floor(Math.random() * 1000);
  const profileDir = path.resolve(process.cwd(), ".aura-chrome-profile");
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
      await sleep(5_000);
      const results: AuraCheckResult[] = [];

      for (const address of addresses) {
        results.push(await checkOneInBrowser(client, address));
      }

      return results;
    } finally {
      client.close();
    }
  } finally {
    chrome.kill();
  }
}

async function checkOneInBrowser(client: CdpClient, address: string): Promise<AuraCheckResult> {
  let lastResult: AuraCheckResult | null = null;
  const walletSourceUrl = buildAuraWalletUrl(address);
  const walletPayload = await fetchJsonInBrowser(client, walletSourceUrl);
  const walletParsed = parseAuraPayload(address, walletPayload, walletSourceUrl, "vercel-context:wallet");

  if (walletParsed.found) {
    return walletParsed;
  }

  lastResult = walletParsed;

  for (const searchParam of AURA_SEARCH_PARAMS) {
    const sourceUrl = buildAuraLeaderboardUrl(searchParam, address);
    const payload = await fetchJsonInBrowser(client, sourceUrl);
    const parsed = parseAuraPayload(address, payload, sourceUrl, `vercel-context:${searchParam}`);
    lastResult = parsed;

    if (parsed.found) {
      return parsed;
    }
  }

  return lastResult ?? {
    found: false,
    address,
    rank: null,
    aura: null,
    referrals: null,
    others: null,
    matchedBy: null,
    sourceUrl: "browser"
  };
}

async function fetchJsonInBrowser(client: CdpClient, sourceUrl: string): Promise<unknown> {
  const payload = await client.evaluateJson(`
    (async () => {
      const response = await fetch(${JSON.stringify(sourceUrl)}, {
        headers: { accept: "application/json, text/plain, */*" },
        credentials: "include"
      });
      const text = await response.text();
      if (!response.ok) {
        return { __auraError: "HTTP " + response.status + ": " + text.slice(0, 500) };
      }
      try {
        return JSON.parse(text);
      } catch {
        return { __auraError: "Invalid JSON: " + text.slice(0, 500) };
      }
    })()
  `);

  if (payload && typeof payload === "object" && "__auraError" in payload) {
    throw new Error(String((payload as { __auraError: unknown }).__auraError));
  }

  return payload;
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

      if (message.error) {
        pending.reject(new Error(message.error.message ?? "Chrome DevTools error"));
        return;
      }

      pending.resolve(message.result);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
