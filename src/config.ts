import fs from "fs";
import path from "path";

import dotenv from "dotenv";

import type { EnvConfig } from "./types";

const DEFAULT_ENV_PATH = path.resolve(process.cwd(), ".env");
const DEFAULT_SECRETS_ENV_PATH = path.resolve(process.cwd(), ".secrets.env");
const DEFAULT_API_BASE_URL = "https://exchange-api.bulk.trade/api/v1";

export function loadConfig(envPath = DEFAULT_ENV_PATH, secretsEnvPath = DEFAULT_SECRETS_ENV_PATH): EnvConfig {
  const rawPublic = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, "utf8")
    : "";
  const parsedPublic = parseEnvLikeFile(rawPublic);
  const rawSecrets = fs.existsSync(secretsEnvPath)
    ? fs.readFileSync(secretsEnvPath, "utf8")
    : "";
  const parsedSecrets = parseEnvLikeFile(rawSecrets);

  const apiBaseUrl = parsedPublic.BULK_API_BASE_URL ?? process.env.BULK_API_BASE_URL ?? DEFAULT_API_BASE_URL;
  const proxyUrl =
    parsedPublic.BULK_PROXY_URL ??
    process.env.BULK_PROXY_URL ??
    process.env.HTTPS_PROXY ??
    process.env.HTTP_PROXY;
  const accountAddress = parsedPublic.BULK_ACCOUNT_ADDRESS ?? process.env.BULK_ACCOUNT_ADDRESS;
  const ownerSecretKey =
    parsedSecrets.BULK_OWNER_SECRET_KEY ??
    parsedPublic.BULK_OWNER_SECRET_KEY ??
    process.env.BULK_OWNER_SECRET_KEY;
  const agentSecretKey = parsedSecrets.BULK_AGENT_SECRET_KEY ?? process.env.BULK_AGENT_SECRET_KEY;
  const agentPublicKey = parsedPublic.BULK_AGENT_PUBLIC_KEY ?? process.env.BULK_AGENT_PUBLIC_KEY;
  const rawDefaultLeverage = parsedPublic.BULK_DEFAULT_LEVERAGE ?? process.env.BULK_DEFAULT_LEVERAGE;

  return {
    apiBaseUrl,
    proxyUrl,
    accountAddress,
    ownerSecretKey,
    agentSecretKey,
    agentPublicKey,
    defaultLeverage: rawDefaultLeverage ? Number(rawDefaultLeverage) : undefined,
    envPath,
    secretsEnvPath
  };
}

export function upsertEnvFile(envPath: string, updates: Record<string, string | undefined>): void {
  const current = fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath, "utf8")) : {};

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined || value === "") {
      delete current[key];
      continue;
    }

    current[key] = value;
  }

  const lines = Object.entries(current)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`);

  fs.writeFileSync(envPath, `${lines.join("\n")}\n`, "utf8");
}

function parseEnvLikeFile(raw: string): Record<string, string> {
  const trimmed = raw.trim();

  if (!trimmed) {
    return {};
  }

  if (trimmed.includes("=") || trimmed.includes("\n")) {
    return dotenv.parse(raw);
  }

  return {
    BULK_OWNER_SECRET_KEY: trimmed
  };
}
