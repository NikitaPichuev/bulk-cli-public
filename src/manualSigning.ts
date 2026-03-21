import bs58Package from "bs58";
import nacl from "tweetnacl";

import type { NativeKeypair } from "./nativeBulk";
import type { ActionEnvelope } from "./types";

const bs58 = bs58Package;

const ACTION_CODES: Record<string, number> = {
  order: 0,
  oracle: 1,
  faucet: 2,
  updateUserSettings: 3,
  agentWalletCreation: 4
};

const ORDER_ITEM_CODES: Record<string, number> = {
  order: 0,
  cancel: 1,
  cancelAll: 2
};

const TIME_IN_FORCE_CODES: Record<string, number> = {
  GTC: 0,
  IOC: 1,
  ALO: 2
};

export function signOrderActions(params: {
  account: string;
  signerKeypair: NativeKeypair;
  actions: unknown[];
  nonce: number;
  orderId?: string;
}): ActionEnvelope {
  return signActions({
    account: params.account,
    signerKeypair: params.signerKeypair,
    actions: params.actions,
    nonce: params.nonce,
    orderId: params.orderId
  });
}

export function signFaucetAction(params: {
  account: string;
  signerKeypair: NativeKeypair;
  nonce: number;
  amount?: number;
}): ActionEnvelope {
  const action = {
    faucet: {
      u: params.account,
      ...(params.amount !== undefined ? { amount: params.amount } : {})
    }
  };

  return signActions({
    account: params.account,
    signerKeypair: params.signerKeypair,
    actions: [action],
    nonce: params.nonce
  });
}

export function signAgentWalletAction(params: {
  account: string;
  signerKeypair: NativeKeypair;
  nonce: number;
  agentPubkey: string;
  deleteFlag: boolean;
}): ActionEnvelope {
  return signActions({
    account: params.account,
    signerKeypair: params.signerKeypair,
    nonce: params.nonce,
    actions: [
      {
        agentWalletCreation: {
          a: params.agentPubkey,
          d: params.deleteFlag
        }
      }
    ]
  });
}

export function signUserSettingsAction(params: {
  account: string;
  signerKeypair: NativeKeypair;
  nonce: number;
  leverageMap: Record<string, number>;
}): ActionEnvelope {
  return signActions({
    account: params.account,
    signerKeypair: params.signerKeypair,
    nonce: params.nonce,
    actions: [
      {
        updateUserSettings: {
          m: params.leverageMap
        }
      }
    ]
  });
}

function signActions(params: {
  account: string;
  signerKeypair: NativeKeypair;
  nonce: number;
  actions: unknown[];
  orderId?: string;
}): ActionEnvelope {
  const actionsBytes = serializeActions(params.actions as Array<Record<string, any>>);
  const message = concatBytes(actionsBytes, writeU64(params.nonce), decodeBase58(params.account));
  const signature = nacl.sign.detached(message, decodeBase58(params.signerKeypair.toBase58()));

  return {
    actions: params.actions,
    nonce: params.nonce,
    account: params.account,
    signer: params.signerKeypair.pubkey,
    signature: bs58.encode(signature),
    orderId: params.orderId
  };
}

function serializeActions(actions: Array<Record<string, any>>): Uint8Array {
  const parts: Uint8Array[] = [writeU64(actions.length)];

  for (const action of actions) {
    parts.push(serializeAction(action));
  }

  return concatBytes(...parts);
}

function serializeAction(action: Record<string, any>): Uint8Array {
  if (action.l || action.m || action.cx || action.cxa) {
    return concatBytes(writeU32(ACTION_CODES.order), writeU64(1), serializeOrderItem(action));
  }

  if (action.faucet) {
    return concatBytes(writeU32(ACTION_CODES.faucet), serializeFaucet(action.faucet));
  }

  if (action.agentWalletCreation) {
    return concatBytes(writeU32(ACTION_CODES.agentWalletCreation), serializeAgentWallet(action.agentWalletCreation));
  }

  if (action.updateUserSettings) {
    return concatBytes(writeU32(ACTION_CODES.updateUserSettings), serializeUpdateUserSettings(action.updateUserSettings));
  }

  throw new Error(`Unsupported action for manual signing: ${JSON.stringify(action)}`);
}

function serializeOrderItem(action: Record<string, any>): Uint8Array {
  if (action.l) {
    const order = action.l;
    return concatBytes(
      writeU32(ORDER_ITEM_CODES.order),
      writeString(order.c),
      writeBool(order.b),
      writeF64(order.px),
      writeF64(order.sz),
      writeBool(order.r),
      writeU32(0),
      writeU32(TIME_IN_FORCE_CODES[order.tif] ?? TIME_IN_FORCE_CODES.GTC),
      writeBool(false)
    );
  }

  if (action.m) {
    const order = action.m;
    return concatBytes(
      writeU32(ORDER_ITEM_CODES.order),
      writeString(order.c),
      writeBool(order.b),
      writeF64(0),
      writeF64(order.sz),
      writeBool(order.r),
      writeU32(1),
      writeBool(true),
      writeF64(0),
      writeBool(false)
    );
  }

  if (action.cx) {
    const cancel = action.cx;
    return concatBytes(writeU32(ORDER_ITEM_CODES.cancel), writeString(cancel.c), decodeBase58(cancel.oid));
  }

  if (action.cxa) {
    const cancelAll = action.cxa;
    const symbols = cancelAll.c ?? [];
    return concatBytes(writeU32(ORDER_ITEM_CODES.cancelAll), writeU64(symbols.length), ...symbols.map(writeString));
  }

  throw new Error(`Unsupported order action: ${JSON.stringify(action)}`);
}

function serializeFaucet(faucet: { u: string; amount?: number }): Uint8Array {
  const parts: Uint8Array[] = [decodeBase58(faucet.u)];

  if (faucet.amount === undefined) {
    parts.push(writeBool(false));
  } else {
    parts.push(writeBool(true), writeF64(faucet.amount));
  }

  return concatBytes(...parts);
}

function serializeAgentWallet(agent: { a: string; d: boolean }): Uint8Array {
  return concatBytes(decodeBase58(agent.a), writeBool(agent.d));
}

function serializeUpdateUserSettings(settings: { m: Record<string, number> }): Uint8Array {
  const entries = Object.entries(settings.m ?? {});
  const parts: Uint8Array[] = [writeU64(entries.length)];

  for (const [symbol, leverage] of entries) {
    parts.push(writeString(symbol), writeF64(leverage));
  }

  return concatBytes(...parts);
}

function writeBool(value: boolean): Uint8Array {
  return Uint8Array.from([value ? 1 : 0]);
}

function writeU32(value: number): Uint8Array {
  const buffer = new Uint8Array(4);
  new DataView(buffer.buffer).setUint32(0, value, true);
  return buffer;
}

function writeU64(value: number | bigint): Uint8Array {
  const buffer = new Uint8Array(8);
  new DataView(buffer.buffer).setBigUint64(0, BigInt(value), true);
  return buffer;
}

function writeF64(value: number): Uint8Array {
  const buffer = new Uint8Array(8);
  new DataView(buffer.buffer).setFloat64(0, value, true);
  return buffer;
}

function writeString(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  return concatBytes(writeU64(bytes.length), bytes);
}

function decodeBase58(value: string): Uint8Array {
  return bs58.decode(value);
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}
