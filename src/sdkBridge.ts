import { spawnSync } from "child_process";
import path from "path";

import type { ApiResponse, BulkApiClient } from "./bulkApi";
import type { NativeKeypair } from "./nativeBulk";

export function submitSdkActions(
  api: BulkApiClient,
  signerKeypair: NativeKeypair,
  account: string,
  actions: Array<Record<string, unknown>>,
  nonce?: number
): ApiResponse {
  const scriptPath = path.resolve(process.cwd(), "bulk_sdk_bridge.py");
  const payload = {
    operation: "submit",
    baseUrl: api.getBaseUrl(),
    proxyUrl: api.getProxyUrl(),
    privateKey: signerKeypair.toBase58(),
    account,
    actions,
    nonce
  };

  const result = spawnSync("python", [scriptPath], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    const stdout = (result.stdout ?? "").trim();
    throw new Error(stderr || stdout || `Python SDK bridge exited with code ${result.status}`);
  }

  const text = (result.stdout ?? "").trim();

  if (!text) {
    throw new Error("Python SDK bridge returned an empty response.");
  }

  return JSON.parse(text) as ApiResponse;
}
