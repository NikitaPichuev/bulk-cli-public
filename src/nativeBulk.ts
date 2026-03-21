import path from "path";

import type { ActionEnvelope, SignedEnvelope } from "./types";

type NativeTxEnvelope = SignedEnvelope | SignedEnvelope[];

interface NativeKeypairInstance {
  pubkey: string;
  secretKey(): Uint8Array;
  toBase58(): string;
  toBytes(): Uint8Array;
}

interface NativeKeypairStatic {
  new (): NativeKeypairInstance;
  fromBase58(value: string): NativeKeypairInstance;
  fromBytes(value: Uint8Array): NativeKeypairInstance;
}

interface NativeSignerInstance {
  pubkey: string;
  signAll(items: unknown[], nonce: number, account: string): SignedEnvelope[];
  signAgentWallet(agentPubkey: string, deleteFlag: boolean, nonce: number, account: string): SignedEnvelope;
  signFaucet(nonce: number, amount?: number | null, account?: string): SignedEnvelope;
  signUserSettings(settings: Array<{ symbol: string; leverage: number }>, nonce: number, account: string): SignedEnvelope;
}

interface NativeSignerStatic {
  new (keypair: NativeKeypairInstance): NativeSignerInstance;
}

interface NativeModule {
  NativeKeypair: NativeKeypairStatic;
  NativeSigner: NativeSignerStatic;
}

function resolveNativeBinary(): string {
  const pkgPath = require.resolve("bulk-keychain/package.json");
  const pkgDir = path.dirname(pkgPath);

  const platformMap: Record<string, string> = {
    win32: "win32",
    linux: "linux",
    darwin: "darwin"
  };

  const archMap: Record<string, string> = {
    x64: "x64",
    arm64: "arm64"
  };

  const platform = platformMap[process.platform];
  const arch = archMap[process.arch];

  if (!platform || !arch) {
    throw new Error(`Unsupported runtime for bulk-keychain: ${process.platform}/${process.arch}`);
  }

  const suffix =
    platform === "win32"
      ? `${platform}-${arch}-msvc.node`
      : platform === "linux"
        ? `${platform}-${arch}-gnu.node`
        : `${platform}-${arch}.node`;

  return path.join(pkgDir, `bulk-keychain.${suffix}`);
}

const native = require(resolveNativeBinary()) as NativeModule;

export type NativeKeypair = NativeKeypairInstance;
export type NativeSigner = NativeSignerInstance;

export function createKeypair(): NativeKeypair {
  return new native.NativeKeypair();
}

export function loadKeypair(secret: string): NativeKeypair {
  const trimmed = secret.trim();

  if (trimmed.startsWith("[")) {
    const values = JSON.parse(trimmed) as number[];
    return native.NativeKeypair.fromBytes(Uint8Array.from(values));
  }

  return native.NativeKeypair.fromBase58(trimmed);
}

export function createSigner(keypair: NativeKeypair): NativeSigner {
  return new native.NativeSigner(keypair);
}

export function nextNonce(): number {
  const micros = Date.now() * 1000;
  const randomSuffix = Math.floor(Math.random() * 1000);
  return micros + randomSuffix;
}

export function decodeEnvelope(envelope: SignedEnvelope): ActionEnvelope {
  const actions = JSON.parse(envelope.actions) as unknown[];

  for (const item of actions as Array<Record<string, any>>) {
    const settings = item?.updateUserSettings;

    if (settings && Array.isArray(settings.m)) {
      settings.m = Object.fromEntries(settings.m as Array<[string, number]>);
    }
  }

  return {
    ...envelope,
    actions
  };
}

export function decodeEnvelopeArray(envelope: NativeTxEnvelope): ActionEnvelope[] {
  const list = Array.isArray(envelope) ? envelope : [envelope];
  return list.map(decodeEnvelope);
}
