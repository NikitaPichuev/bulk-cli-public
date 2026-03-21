export type OrderTimeInForce = "GTC" | "IOC" | "ALO";

export interface ExchangeSymbolInfo {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: string;
  pricePrecision: number;
  sizePrecision: number;
  tickSize: number;
  lotSize: number;
  minNotional: number;
  maxLeverage: number;
  orderTypes: string[];
  timeInForces: string[];
}

export interface Position {
  symbol?: string;
  coin?: string;
  size: number;
  price?: number;
  realizedPnl?: number;
  leverage?: number;
  entryPrice?: number;
  markPrice?: number;
  pnl?: number;
}

export interface OpenOrder {
  symbol: string;
  orderId: string;
  price: number;
  originalSize: number;
  size: number;
  filledSize: number;
  vwap: number;
  isBuy: boolean;
  maker: boolean;
  reduceOnly: boolean;
  tif: string;
  status: string;
  timestamp: number;
}

export interface MarginSnapshot {
  totalBalance?: number;
  availableBalance?: number;
  marginUsed?: number;
  notional?: number;
  realizedPnl?: number;
  unrealizedPnl?: number;
  fees?: number;
  funding?: number;
}

export interface LeverageSetting {
  symbol: string;
  leverage: number;
}

export interface FullAccountState {
  margin?: MarginSnapshot;
  positions: Position[];
  openOrders: OpenOrder[];
  leverageSettings?: LeverageSetting[];
}

export interface SignedEnvelope {
  actions: string;
  nonce: number;
  account: string;
  signer: string;
  signature: string;
  orderId?: string;
}

export interface ActionEnvelope {
  actions: unknown[];
  nonce: number;
  account: string;
  signer: string;
  signature: string;
  orderId?: string;
}

export interface EnvConfig {
  apiBaseUrl: string;
  proxyUrl?: string;
  accountAddress?: string;
  ownerSecretKey?: string;
  agentSecretKey?: string;
  agentPublicKey?: string;
  defaultLeverage?: number;
  envPath: string;
  secretsEnvPath: string;
}

export interface WalletProfile {
  name: string;
  ownerSecretKey: string;
  accountAddress?: string;
  agentSecretKey?: string;
  agentPublicKey?: string;
  enabled?: boolean;
}
