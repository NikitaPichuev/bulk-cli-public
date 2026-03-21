import { Agent, ProxyAgent, setGlobalDispatcher } from "undici";

import type { EnvConfig } from "./types";

let configuredProxyUrl: string | null = null;
let directAgentConfigured = false;

export function configureNetworking(config: EnvConfig, overrideProxyUrl?: string | null): void {
  const proxyUrl = normalizeProxyUrlInput(
    overrideProxyUrl ??
    config.proxyUrl ??
    process.env.HTTPS_PROXY ??
    process.env.HTTP_PROXY ??
    null
  );

  if (!proxyUrl) {
    if (configuredProxyUrl === null && directAgentConfigured) {
      return;
    }

    setGlobalDispatcher(new Agent());
    configuredProxyUrl = null;
    directAgentConfigured = true;
    return;
  }

  if (proxyUrl === configuredProxyUrl) {
    return;
  }

  setGlobalDispatcher(new ProxyAgent(proxyUrl));
  configuredProxyUrl = proxyUrl;
  directAgentConfigured = false;
}

export function normalizeProxyUrlInput(proxyUrl?: string | null): string | null {
  if (!proxyUrl) {
    return null;
  }

  const trimmed = proxyUrl.trim();

  if (!trimmed) {
    return null;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `http://${trimmed}`;
}

export async function getVisibleIp(): Promise<string> {
  const response = await fetch("https://api.ipify.org?format=json", {
    signal: AbortSignal.timeout(15_000)
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`IP check failed: HTTP ${response.status}: ${text}`);
  }

  let payload: { ip?: string };

  try {
    payload = JSON.parse(text) as { ip?: string };
  } catch {
    throw new Error(`IP check failed: invalid JSON: ${text}`);
  }

  if (!payload.ip) {
    throw new Error(`IP check failed: missing ip field: ${text}`);
  }

  return payload.ip;
}
