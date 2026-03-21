import fs from "fs";
import path from "path";

import type { WalletProfile } from "./types";

export function resolveWalletFile(filePath: string): string {
  return path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);
}

export function loadWalletProfiles(filePath: string): WalletProfile[] {
  const resolved = resolveWalletFile(filePath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`Wallets file not found: ${resolved}`);
  }

  const raw = fs.readFileSync(resolved, "utf8");
  const parsed = JSON.parse(raw) as unknown;

  if (!Array.isArray(parsed)) {
    throw new Error(`Wallets file must contain a JSON array: ${resolved}`);
  }

  return parsed.map((item, index) => normalizeProfile(item, index));
}

export function saveWalletProfiles(filePath: string, profiles: WalletProfile[]): void {
  const resolved = resolveWalletFile(filePath);
  fs.writeFileSync(resolved, `${JSON.stringify(profiles, null, 2)}\n`, "utf8");
}

export function loadProxyLines(filePath: string): Array<string | undefined> {
  const resolved = resolveWalletFile(filePath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`Proxies file not found: ${resolved}`);
  }

  const raw = fs.readFileSync(resolved, "utf8").replace(/^\uFEFF/, "");
  const lines = raw.split(/\r?\n/);

  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines.map((line) => {
    const trimmed = line.trim();
    return trimmed ? trimmed : undefined;
  });
}

function normalizeProfile(item: unknown, index: number): WalletProfile {
  if (typeof item === "string" && item.trim()) {
    return {
      name: `wallet-${index + 1}`,
      ownerSecretKey: item.trim(),
      enabled: true
    };
  }

  if (!item || typeof item !== "object") {
    throw new Error(`Invalid wallet profile at index ${index}`);
  }

  const profile = item as Record<string, unknown>;
  const name = typeof profile.name === "string" && profile.name.trim()
    ? profile.name.trim()
    : `wallet-${index + 1}`;

  if (typeof profile.ownerSecretKey !== "string" || !profile.ownerSecretKey.trim()) {
    throw new Error(`Missing ownerSecretKey for wallet profile "${name}"`);
  }

  return {
    name,
    ownerSecretKey: profile.ownerSecretKey.trim(),
    accountAddress: typeof profile.accountAddress === "string" ? profile.accountAddress.trim() : undefined,
    agentSecretKey: typeof profile.agentSecretKey === "string" ? profile.agentSecretKey.trim() : undefined,
    agentPublicKey: typeof profile.agentPublicKey === "string" ? profile.agentPublicKey.trim() : undefined,
    enabled: typeof profile.enabled === "boolean" ? profile.enabled : true
  };
}
