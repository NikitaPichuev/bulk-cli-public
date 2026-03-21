#!/usr/bin/env node
import fs from "fs";
import { Command } from "commander";

import { BulkApiClient, ensureAcceptedStatuses } from "./bulkApi";
import { loadConfig, upsertEnvFile } from "./config";
import { signAgentWalletAction, signFaucetAction, signOrderActions, signUserSettingsAction } from "./manualSigning";
import { createKeypair, loadKeypair, nextNonce } from "./nativeBulk";
import { configureNetworking, getVisibleIp, normalizeProxyUrlInput } from "./network";
import type { EnvConfig, ExchangeSymbolInfo, FullAccountState, OrderTimeInForce, Position, WalletProfile } from "./types";
import { loadProxyLines, loadWalletProfiles, resolveWalletFile, saveWalletProfiles } from "./walletProfiles";

interface TradingIdentity {
  accountAddress: string;
  keypair: ReturnType<typeof loadKeypair>;
}

interface ResolvedOrderSize {
  mode: "size" | "percent";
  size: number;
  percentOfAvailableBalance: number | null;
  referencePrice: number | null;
  leverage: number | null;
  estimatedMarginUsed: number | null;
  estimatedNotional: number | null;
}

interface BatchCommandOptions {
  file?: string;
  proxiesFile?: string;
  delayMs?: string;
  jitterMs?: string;
  dryRun?: boolean;
  skipFaucet?: boolean;
  skipMaxLeverage?: boolean;
  leverage?: string;
}

const SYMBOL_ALIASES: Record<string, string> = {
  BTC: "BTC-USD",
  ETH: "ETH-USD",
  SOL: "SOL-USD",
  XRP: "XRP-USD",
  GOLD: "GOLD-USD"
};

const MARKET_ORDER_SAFETY_FACTOR = 0.985;
const BATCH_CONNECT_RETRY_ATTEMPTS = 3;
const BATCH_CONNECT_RETRY_DELAY_MIN_MS = 3_000;
const BATCH_CONNECT_RETRY_DELAY_MAX_MS = 5_000;
const TEST_FUNDS_CLAIM_ATTEMPTS = 2;
const TEST_FUNDS_BALANCE_POLL_ATTEMPTS = 4;
const TEST_FUNDS_BALANCE_POLL_DELAY_MS = 1_500;

interface TestFundsResult {
  faucetRequested: boolean;
  faucetStatus: "claimed" | "already_claimed" | "skipped";
  balanceVerified: boolean;
  totalBalance: number | null;
  availableBalance: number | null;
}

const program = new Command();

program
  .name("bulk-cli")
  .description("Minimal CLI for Bulk testnet perp trading via direct API")
  .version("0.1.0");

program
  .command("ip")
  .description("Show the current visible external IP for this process")
  .action(async () => {
    const config = loadConfig();
    configureNetworking(config);

    const ip = await getVisibleIp();
    console.log(JSON.stringify({
      ok: true,
      ip,
      proxyUrl: maskProxyUrl(config.proxyUrl)
    }, null, 2));
  });

program
  .command("connect")
  .description("Request faucet, register agent wallet, and save .env + .secrets.env")
  .option("--owner-secret <secret>", "Owner wallet secret key. Accepts base58 or JSON byte array.")
  .option("--save-owner-secret", "Persist BULK_OWNER_SECRET_KEY into .secrets.env", false)
  .option("--skip-faucet", "Do not request faucet during connect", false)
  .option("--skip-max-leverage", "Do not set max leverage for all symbols after connect", false)
  .action(async (options: { ownerSecret?: string; saveOwnerSecret?: boolean; skipFaucet?: boolean; skipMaxLeverage?: boolean }) => {
    const config = loadConfig();
    configureNetworking(config);
    const ownerSecret = options.ownerSecret ?? config.ownerSecretKey;

    if (!ownerSecret) {
      fail("Для connect нужен owner secret: передай `--owner-secret` или заполни BULK_OWNER_SECRET_KEY в .secrets.env.");
    }

    const api = new BulkApiClient(config.apiBaseUrl);
    const ownerKeypair = loadKeypair(ownerSecret);
    const existingAgentKeypair = config.agentSecretKey ? loadKeypair(config.agentSecretKey) : undefined;
    const agentKeypair =
      existingAgentKeypair && existingAgentKeypair.pubkey !== ownerKeypair.pubkey
        ? existingAgentKeypair
        : createKeypair();

    const authResponse = await api.submit(signAgentWalletAction({
      account: ownerKeypair.pubkey,
      signerKeypair: ownerKeypair,
      nonce: nextNonce(),
      agentPubkey: agentKeypair.pubkey,
      deleteFlag: false
    }));
    try {
      ensureAcceptedStatuses(authResponse, "agent wallet registration");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("agent wallet already exists")) {
        throw error;
      }
    }

    if (!options.skipMaxLeverage) {
      const exchangeInfo = await api.getExchangeInfo();
      const settingsResponse = await api.submit(signUserSettingsAction({
        account: ownerKeypair.pubkey,
        signerKeypair: ownerKeypair,
        nonce: nextNonce(),
        leverageMap: Object.fromEntries(exchangeInfo.map((item) => [item.symbol, item.maxLeverage]))
      }));
      ensureAcceptedStatuses(settingsResponse, "max leverage setup");
    }

    const testFunds = await ensureTestFundsReady(api, ownerKeypair, options.skipFaucet ?? false);

    upsertEnvFile(config.envPath, {
      BULK_API_BASE_URL: config.apiBaseUrl,
      BULK_ACCOUNT_ADDRESS: ownerKeypair.pubkey,
      BULK_AGENT_PUBLIC_KEY: agentKeypair.pubkey,
      BULK_AGENT_SECRET_KEY: undefined,
      BULK_OWNER_SECRET_KEY: undefined
    });

    upsertEnvFile(config.secretsEnvPath, {
      BULK_AGENT_SECRET_KEY: agentKeypair.toBase58(),
      BULK_OWNER_SECRET_KEY: options.saveOwnerSecret ? ownerSecret : undefined
    });

    console.log(JSON.stringify({
      ok: true,
      account: ownerKeypair.pubkey,
      agentWallet: agentKeypair.pubkey,
      envFile: config.envPath,
      secretsEnvFile: config.secretsEnvPath,
      faucetRequested: !options.skipFaucet,
      maxLeverageConfigured: !options.skipMaxLeverage,
      testFunds
    }, null, 2));
  });

program
  .command("faucet")
  .description("Request testnet faucet for the configured account")
  .option("--owner", "Sign faucet with the owner key instead of the agent key", false)
  .action(async (options: { owner?: boolean }) => {
    const config = loadConfig();
    configureNetworking(config);
    const api = new BulkApiClient(config.apiBaseUrl);
    const identity = options.owner ? requireOwnerIdentity(config) : requireTradingIdentity(config);

    const testFunds = await ensureTestFundsReady(api, identity.keypair, false, identity.accountAddress);

    console.log(JSON.stringify({
      ok: true,
      account: identity.accountAddress,
      testFunds
    }, null, 2));
  });

program
  .command("buy")
  .description("Open or add to a long position")
  .argument("<symbol>", "Market symbol: BTC, ETH, SOL or full symbol like BTC-USD")
  .argument("<size-or-percent>", "Base size, fixed percent like 50%, or range like 40-50%")
  .option("--price <price>", "Limit price. If omitted, market order is used.")
  .option("--tif <tif>", "Time in force for limit orders: GTC, IOC, ALO", "GTC")
  .option("--leverage <value>", "Set leverage for this symbol before sending the order")
  .action(async (symbol: string, sizeOrPercent: string, options: { price?: string; tif?: OrderTimeInForce; leverage?: string }) => {
    await submitOrder({ side: "buy", symbol, sizeOrPercent, options });
  });

program
  .command("sell")
  .description("Open or add to a short position")
  .argument("<symbol>", "Market symbol: BTC, ETH, SOL or full symbol like BTC-USD")
  .argument("<size-or-percent>", "Base size, fixed percent like 50%, or range like 40-50%")
  .option("--price <price>", "Limit price. If omitted, market order is used.")
  .option("--tif <tif>", "Time in force for limit orders: GTC, IOC, ALO", "GTC")
  .option("--leverage <value>", "Set leverage for this symbol before sending the order")
  .action(async (symbol: string, sizeOrPercent: string, options: { price?: string; tif?: OrderTimeInForce; leverage?: string }) => {
    await submitOrder({ side: "sell", symbol, sizeOrPercent, options });
  });

program
  .command("close")
  .description("Close the current position in one symbol with a reduce-only market order")
  .argument("<symbol>", "Market symbol: BTC, ETH, SOL or full symbol like BTC-USD")
  .action(async (symbol: string) => {
    const config = loadConfig();
    configureNetworking(config);
    const api = new BulkApiClient(config.apiBaseUrl);
    const identity = requireTradingIdentity(config);
    const account = await api.getFullAccount(identity.accountAddress);
    const normalizedSymbol = normalizeSymbol(symbol);
    const position = account.positions.find((item) => getPositionSymbol(item) === normalizedSymbol);

    if (!position || !position.size) {
      console.log(JSON.stringify({ ok: true, symbol: normalizedSymbol, message: "No open position." }, null, 2));
      return;
    }

    const response = await api.submit(signOrderActions({
      account: identity.accountAddress,
      signerKeypair: identity.keypair,
      nonce: nextNonce(),
      actions: [
        {
          m: {
            c: normalizedSymbol,
            b: position.size < 0,
            sz: Math.abs(position.size),
            r: true
          }
        }
      ]
    }));

    console.log(JSON.stringify({
      ok: true,
      symbol: normalizedSymbol,
      closedSize: Math.abs(position.size),
      statuses: ensureAcceptedStatuses(response, `close ${normalizedSymbol}`)
    }, null, 2));
  });

program
  .command("positions")
  .description("Print open positions and account margin snapshot")
  .option("--json", "Print raw JSON", false)
  .action(async (options: { json?: boolean }) => {
    const config = loadConfig();
    configureNetworking(config);

    if (!config.accountAddress) {
      fail("Не найден BULK_ACCOUNT_ADDRESS. Сначала выполни `connect`.");
    }

    const api = new BulkApiClient(config.apiBaseUrl);
    const account = await api.getFullAccount(config.accountAddress);

    if (options.json) {
      console.log(JSON.stringify(account, null, 2));
      return;
    }

    console.log("Margin:");
    console.table([account.margin ?? {}]);
    console.log("Positions:");
    console.table(account.positions.map((item) => ({
      symbol: getPositionSymbol(item),
      size: item.size,
      entry: item.price ?? item.entryPrice ?? null,
      leverage: item.leverage ?? null,
      realizedPnl: item.realizedPnl ?? null
    })));

    if (account.openOrders.length > 0) {
      console.log("Open orders:");
      console.table(account.openOrders.map((item) => ({
        symbol: item.symbol,
        orderId: item.orderId,
        side: item.isBuy ? "buy" : "sell",
        price: item.price,
        size: item.size,
        status: item.status,
        reduceOnly: item.reduceOnly
      })));
    }
  });

program
  .command("batch-connect")
  .description("Connect a JSON list of wallets, create/register agent wallets, and persist them back to the file")
  .option("--file <path>", "Wallets JSON file", ".wallets.json")
  .option("--proxies-file <path>", "Optional proxies text file, one proxy per line", ".proxies.txt")
  .option("--delay-ms <ms>", "Base delay between wallets in milliseconds", "11000")
  .option("--jitter-ms <ms>", "Random extra delay between wallets in milliseconds", "12000")
  .option("--skip-faucet", "Do not request faucet during connect", false)
  .option("--skip-max-leverage", "Do not set max leverage for all symbols after connect", false)
  .option("--dry-run", "Show schedule without sending requests", false)
  .action(async (options: BatchCommandOptions) => {
    const config = loadConfig();
    configureNetworking(config);
    const filePath = resolveWalletFile(options.file ?? ".wallets.json");
    const profiles = loadWalletProfiles(filePath).filter((item) => item.enabled !== false);
    const proxies = resolveBatchProxies(options, profiles.length);
    const api = new BulkApiClient(config.apiBaseUrl);
    const plan = getBatchPlan(profiles.length, options.delayMs, options.jitterMs);
    const results: Array<Record<string, unknown>> = [];

    console.log(`[batch-connect] wallets=${profiles.length}, file=${filePath}`);

    for (let index = 0; index < profiles.length; index += 1) {
      const profile = profiles[index];
      const proxyUrl = proxies[index];
      configureNetworking(config, proxyUrl);
      logBatchProgress("connect", index, profiles.length, profile.name, plan[index]);

      if (options.dryRun) {
        results.push({
          name: profile.name,
          scheduledAfterMs: plan[index],
          action: "connect"
        });
        continue;
      }

      if (plan[index] > 0) {
        await sleep(plan[index]);
      }

      try {
        const updated = await retryBatchConnect(profile.name, async (attempt) => {
          if (attempt > 1) {
            console.log(`[connect retry ${attempt}/${BATCH_CONNECT_RETRY_ATTEMPTS}] ${profile.name}`);
          }

          return await connectWalletProfile(api, profile, {
            skipFaucet: options.skipFaucet ?? false,
            skipMaxLeverage: options.skipMaxLeverage ?? false
          });
        });

        profiles[index] = updated.profile;
        saveWalletProfiles(filePath, profiles);
        results.push({
          ok: true,
          name: updated.profile.name,
          account: updated.profile.accountAddress,
          agentWallet: updated.profile.agentPublicKey,
          testFunds: updated.testFunds,
          proxyUsed: maskProxyUrl(proxyUrl ?? config.proxyUrl),
          scheduledAfterMs: plan[index]
        });
        console.log(`[connect ok] ${updated.profile.name} -> ${updated.profile.accountAddress}`);
      } catch (error) {
        results.push({
          ok: false,
          name: profile.name,
          account: profile.accountAddress,
          proxyUsed: maskProxyUrl(proxyUrl ?? config.proxyUrl),
          scheduledAfterMs: plan[index],
          error: formatError(error)
        });
        console.log(`[connect error] ${profile.name}: ${formatError(error)}`);
      }
    }

    const failed = results.some((item) => item.ok === false);
    console.log(JSON.stringify({
      ok: !failed,
      file: filePath,
      wallets: results
    }, null, 2));
  });

program
  .command("batch-buy")
  .description("Open long positions for a JSON list of wallets with staggered timing")
  .argument("<symbol>", "Market symbol: BTC, ETH, SOL or full symbol like BTC-USD")
  .argument("<size-or-percent>", "Base size, fixed percent like 50%, or range like 40-50%")
  .option("--file <path>", "Wallets JSON file", ".wallets.json")
  .option("--proxies-file <path>", "Optional proxies text file, one proxy per line", ".proxies.txt")
  .option("--delay-ms <ms>", "Base delay between wallets in milliseconds", "11000")
  .option("--jitter-ms <ms>", "Random extra delay between wallets in milliseconds", "12000")
  .option("--price <price>", "Limit price. If omitted, market order is used.")
  .option("--tif <tif>", "Time in force for limit orders: GTC, IOC, ALO", "GTC")
  .option("--leverage <value>", "Set leverage for this symbol before sending the order")
  .option("--dry-run", "Show schedule without sending requests", false)
  .action(async (symbol: string, sizeOrPercent: string, options: BatchCommandOptions & { price?: string; tif?: OrderTimeInForce }) => {
    await executeBatchOrder({
      side: "buy",
      symbol,
      sizeOrPercent,
      options
    });
  });

program
  .command("batch-sell")
  .description("Open short positions for a JSON list of wallets with staggered timing")
  .argument("<symbol>", "Market symbol: BTC, ETH, SOL or full symbol like BTC-USD")
  .argument("<size-or-percent>", "Base size, fixed percent like 50%, or range like 40-50%")
  .option("--file <path>", "Wallets JSON file", ".wallets.json")
  .option("--proxies-file <path>", "Optional proxies text file, one proxy per line", ".proxies.txt")
  .option("--delay-ms <ms>", "Base delay between wallets in milliseconds", "11000")
  .option("--jitter-ms <ms>", "Random extra delay between wallets in milliseconds", "12000")
  .option("--price <price>", "Limit price. If omitted, market order is used.")
  .option("--tif <tif>", "Time in force for limit orders: GTC, IOC, ALO", "GTC")
  .option("--leverage <value>", "Set leverage for this symbol before sending the order")
  .option("--dry-run", "Show schedule without sending requests", false)
  .action(async (symbol: string, sizeOrPercent: string, options: BatchCommandOptions & { price?: string; tif?: OrderTimeInForce }) => {
    await executeBatchOrder({
      side: "sell",
      symbol,
      sizeOrPercent,
      options
    });
  });

program
  .command("batch-close")
  .description("Close one symbol across a JSON list of wallets with staggered timing")
  .argument("<symbol>", "Market symbol: BTC, ETH, SOL or full symbol like BTC-USD")
  .option("--file <path>", "Wallets JSON file", ".wallets.json")
  .option("--proxies-file <path>", "Optional proxies text file, one proxy per line", ".proxies.txt")
  .option("--delay-ms <ms>", "Base delay between wallets in milliseconds", "11000")
  .option("--jitter-ms <ms>", "Random extra delay between wallets in milliseconds", "12000")
  .option("--dry-run", "Show schedule without sending requests", false)
  .action(async (symbol: string, options: BatchCommandOptions) => {
    const config = loadConfig();
    configureNetworking(config);
    const filePath = resolveWalletFile(options.file ?? ".wallets.json");
    const profiles = loadWalletProfiles(filePath).filter((item) => item.enabled !== false);
    const proxies = resolveBatchProxies(options, profiles.length);
    const api = new BulkApiClient(config.apiBaseUrl);
    const plan = getBatchPlan(profiles.length, options.delayMs, options.jitterMs);
    const normalizedSymbol = normalizeSymbol(symbol);
    const results: Array<Record<string, unknown>> = [];

    console.log(`[batch-close] wallets=${profiles.length}, symbol=${normalizedSymbol}, file=${filePath}`);

    for (let index = 0; index < profiles.length; index += 1) {
      const profile = profiles[index];
      const proxyUrl = proxies[index];
      configureNetworking(config, proxyUrl);
      logBatchProgress("close", index, profiles.length, profile.name, plan[index]);

      if (options.dryRun) {
        results.push({
          name: profile.name,
          scheduledAfterMs: plan[index],
          action: "close",
          symbol: normalizedSymbol
        });
        continue;
      }

      if (plan[index] > 0) {
        await sleep(plan[index]);
      }

      try {
        const closeResult = await closeWalletSymbol(api, profile, normalizedSymbol);
        results.push({
          ok: true,
          name: profile.name,
          account: profile.accountAddress,
          proxyUsed: maskProxyUrl(proxyUrl ?? config.proxyUrl),
          scheduledAfterMs: plan[index],
          ...closeResult
        });
        console.log(`[close ok] ${profile.name} -> ${normalizedSymbol}`);
      } catch (error) {
        results.push({
          ok: false,
          name: profile.name,
          account: profile.accountAddress,
          proxyUsed: maskProxyUrl(proxyUrl ?? config.proxyUrl),
          scheduledAfterMs: plan[index],
          symbol: normalizedSymbol,
          error: formatError(error)
        });
        console.log(`[close error] ${profile.name}: ${formatError(error)}`);
      }
    }

    const failed = results.some((item) => item.ok === false);
    console.log(JSON.stringify({
      ok: !failed,
      file: filePath,
      wallets: results
    }, null, 2));
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});

async function submitOrder(input: {
  side: "buy" | "sell";
  symbol: string;
  sizeOrPercent: string;
  options: { price?: string; tif?: OrderTimeInForce; leverage?: string };
}): Promise<void> {
  const config = loadConfig();
  configureNetworking(config);
  const api = new BulkApiClient(config.apiBaseUrl);
  const identity = requireTradingIdentity(config);
  const symbol = normalizeSymbol(input.symbol);
  const exchangeInfo = await api.getExchangeInfo();
  await ensureLeverage(api, config, identity, symbol, exchangeInfo, input.options.leverage);
  const account = await api.getFullAccount(identity.accountAddress);
  const size = await resolveOrderSize({
    api,
    symbol,
    sizeOrPercent: input.sizeOrPercent,
    exchangeInfo,
    account,
    leverageOverride: input.options.leverage
  });

  const isLimit = input.options.price !== undefined;
  const price = isLimit ? Number(input.options.price) : 0;

  if (isLimit && (!Number.isFinite(price) || price <= 0)) {
    fail("Limit order requires a positive `--price`.");
  }

  const response = await api.submit(signOrderActions({
    account: identity.accountAddress,
    signerKeypair: identity.keypair,
    nonce: nextNonce(),
    actions: [
      isLimit
        ? {
            l: {
              c: symbol,
              b: input.side === "buy",
              px: price,
              sz: size.size,
              tif: (input.options.tif ?? "GTC").toUpperCase() as OrderTimeInForce,
              r: false
            }
          }
        : {
            m: {
              c: symbol,
              b: input.side === "buy",
              sz: size.size,
              r: false
            }
          }
    ]
  }));

  console.log(JSON.stringify({
    ok: true,
    symbol,
    side: input.side,
    requested: input.sizeOrPercent,
    size: size.size,
    sizingMode: size.mode,
    percentOfAvailableBalance: size.percentOfAvailableBalance,
    referencePrice: size.referencePrice,
    leverage: size.leverage,
    estimatedMarginUsed: size.estimatedMarginUsed,
    estimatedNotional: size.estimatedNotional,
    orderType: isLimit ? "limit" : "market",
    price: isLimit ? price : null,
    statuses: ensureAcceptedStatuses(response, `${input.side} ${symbol}`)
  }, null, 2));
}

async function ensureLeverage(
  api: BulkApiClient,
  config: EnvConfig,
  identity: TradingIdentity,
  symbol: string,
  exchangeInfo: ExchangeSymbolInfo[],
  leverageOverride?: string
): Promise<void> {
  const account = await api.getFullAccount(identity.accountAddress);
  const existing = account.leverageSettings?.find((item) => item.symbol === symbol)?.leverage;
  const desired = resolveLeverage(symbol, exchangeInfo, config.defaultLeverage, leverageOverride, existing);

  if (!desired || desired === existing) {
    return;
  }

  const response = await api.submit(signUserSettingsAction({
    account: identity.accountAddress,
    signerKeypair: identity.keypair,
    nonce: nextNonce(),
    leverageMap: { [symbol]: desired }
  }));

  ensureAcceptedStatuses(response, `set leverage for ${symbol}`);
}

async function resolveOrderSize(input: {
  api: BulkApiClient;
  symbol: string;
  sizeOrPercent: string;
  exchangeInfo: ExchangeSymbolInfo[];
  account: FullAccountState;
  leverageOverride?: string;
}): Promise<ResolvedOrderSize> {
  const raw = input.sizeOrPercent.trim();
  const symbolInfo = input.exchangeInfo.find((item) => item.symbol === input.symbol);

  if (!symbolInfo) {
    fail(`Unknown symbol: ${input.symbol}`);
  }

  const percent = resolvePercentInput(raw);

  if (percent === null) {
    const size = Number(raw);

    if (!Number.isFinite(size) || size <= 0) {
      fail("Size must be a positive number, a percent like 50%, or a range like 40-50%.");
    }

    return {
      mode: "size",
      size: roundDownToStep(size, symbolInfo.lotSize),
      percentOfAvailableBalance: null,
      referencePrice: null,
      leverage: null,
      estimatedMarginUsed: null,
      estimatedNotional: null
    };
  }

  if (percent <= 0 || percent > 99) {
    fail("Percent sizing supports values from 0 to 99.");
  }

  if (!["BTC-USD", "ETH-USD", "SOL-USD"].includes(input.symbol)) {
    fail("Percent sizing is enabled for BTC, ETH and SOL only.");
  }

  const availableBalance = input.account.margin?.availableBalance ?? 0;

  if (!Number.isFinite(availableBalance) || availableBalance <= 0) {
    fail("Available balance is zero.");
  }

  const leverage = resolveLeverage(
    input.symbol,
    input.exchangeInfo,
    undefined,
    input.leverageOverride,
    input.account.leverageSettings?.find((item) => item.symbol === input.symbol)?.leverage
  );

  if (!leverage || leverage <= 0) {
    fail(`Failed to resolve leverage for ${input.symbol}.`);
  }

  const referencePrice = await input.api.getReferencePrice(input.symbol);
  const marginBudget = availableBalance * (percent / 100);
  const estimatedNotional = marginBudget * leverage * MARKET_ORDER_SAFETY_FACTOR;
  const rawSize = estimatedNotional / referencePrice;
  const size = roundDownToStep(rawSize, symbolInfo.lotSize);

  if (!Number.isFinite(size) || size <= 0) {
    fail(`Calculated size is too small for ${input.symbol}.`);
  }

  return {
    mode: "percent",
    size,
    percentOfAvailableBalance: percent,
    referencePrice,
    leverage,
    estimatedMarginUsed: marginBudget * MARKET_ORDER_SAFETY_FACTOR,
    estimatedNotional: size * referencePrice
  };
}

function resolveLeverage(
  symbol: string,
  exchangeInfo: ExchangeSymbolInfo[],
  defaultLeverage: number | undefined,
  leverageOverride: string | undefined,
  existing: number | undefined
): number | undefined {
  if (leverageOverride) {
    return Number(leverageOverride);
  }

  if (existing) {
    return existing;
  }

  const symbolInfo = exchangeInfo.find((item) => item.symbol === symbol);
  if (!symbolInfo) {
    fail(`Unknown symbol: ${symbol}`);
  }

  if (defaultLeverage && defaultLeverage > 0) {
    return Math.min(defaultLeverage, symbolInfo.maxLeverage);
  }

  return symbolInfo.maxLeverage;
}

function normalizeSymbol(value: string): string {
  const trimmed = value.trim().toUpperCase();
  return SYMBOL_ALIASES[trimmed] ?? trimmed;
}

function roundDownToStep(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) {
    return value;
  }

  const rounded = Math.floor(value / step) * step;
  const precision = countDecimals(step);
  return Number(rounded.toFixed(precision));
}

function countDecimals(value: number): number {
  const asText = value.toString();

  if (!asText.includes(".")) {
    return 0;
  }

  return asText.split(".")[1]?.length ?? 0;
}

function resolvePercentInput(raw: string): number | null {
  const exactMatch = raw.match(/^(\d+(?:\.\d+)?)%$/);

  if (exactMatch) {
    return Number(exactMatch[1]);
  }

  const rangeMatch = raw.match(/^(\d+(?:\.\d+)?)%?\s*-\s*(\d+(?:\.\d+)?)%$/);

  if (!rangeMatch) {
    return null;
  }

  const min = Number(rangeMatch[1]);
  const max = Number(rangeMatch[2]);

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    fail("Percent range must contain valid numbers.");
  }

  if (min > max) {
    fail("Percent range must be in ascending order, for example 40-50%.");
  }

  return randomPercentInRange(min, max);
}

function randomPercentInRange(min: number, max: number): number {
  const raw = min + Math.random() * (max - min);
  return Number(raw.toFixed(2));
}

function requireOwnerIdentity(config: EnvConfig): TradingIdentity {
  if (!config.accountAddress || !config.ownerSecretKey) {
    fail("Для owner-подписи нужны BULK_ACCOUNT_ADDRESS и BULK_OWNER_SECRET_KEY.");
  }

  return {
    accountAddress: config.accountAddress,
    keypair: loadKeypair(config.ownerSecretKey)
  };
}

function requireTradingIdentity(config: EnvConfig): TradingIdentity {
  if (!config.accountAddress || !config.agentSecretKey) {
    fail("Не найдены BULK_ACCOUNT_ADDRESS или BULK_AGENT_SECRET_KEY. Сначала выполни `connect`.");
  }

  return {
    accountAddress: config.accountAddress,
    keypair: loadKeypair(config.agentSecretKey)
  };
}

function acceptFaucetStatuses(response: Awaited<ReturnType<BulkApiClient["submit"]>>): Array<Record<string, unknown>> {
  try {
    return ensureAcceptedStatuses(response, "faucet");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isAlreadyClaimedFaucetMessage(message)) {
      return response.response?.data?.statuses ?? [];
    }
    throw error;
  }
}

async function ensureTestFundsReady(
  api: BulkApiClient,
  signerKeypair: ReturnType<typeof loadKeypair>,
  skipFaucet: boolean,
  accountAddress?: string
): Promise<TestFundsResult> {
  const account = accountAddress ?? signerKeypair.pubkey;
  let faucetStatus: TestFundsResult["faucetStatus"] = skipFaucet ? "skipped" : "claimed";

  if (!skipFaucet) {
    for (let attempt = 1; attempt <= TEST_FUNDS_CLAIM_ATTEMPTS; attempt += 1) {
      const faucetResponse = await api.submit(signFaucetAction({
        account,
        signerKeypair,
        nonce: nextNonce()
      }));

      try {
        acceptFaucetStatuses(faucetResponse);
        faucetStatus = "claimed";
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!isAlreadyClaimedFaucetMessage(message)) {
          throw error;
        }

        faucetStatus = "already_claimed";
      }

      const balances = await pollTestFundsBalance(api, account);
      if (balances.balanceVerified || faucetStatus === "already_claimed" || attempt === TEST_FUNDS_CLAIM_ATTEMPTS) {
        return {
          faucetRequested: true,
          faucetStatus,
          ...balances
        };
      }

      await sleep(TEST_FUNDS_BALANCE_POLL_DELAY_MS);
    }
  }

  const balances = await pollTestFundsBalance(api, account);
  return {
    faucetRequested: !skipFaucet,
    faucetStatus,
    ...balances
  };
}

async function pollTestFundsBalance(
  api: BulkApiClient,
  accountAddress: string
): Promise<Pick<TestFundsResult, "balanceVerified" | "totalBalance" | "availableBalance">> {
  let lastTotalBalance: number | null = null;
  let lastAvailableBalance: number | null = null;

  for (let attempt = 1; attempt <= TEST_FUNDS_BALANCE_POLL_ATTEMPTS; attempt += 1) {
    const account = await api.getFullAccount(accountAddress);
    const totalBalance = normalizeBalanceValue(account.margin?.totalBalance);
    const availableBalance = normalizeBalanceValue(account.margin?.availableBalance);

    lastTotalBalance = totalBalance;
    lastAvailableBalance = availableBalance;

    if ((totalBalance ?? 0) > 0 || (availableBalance ?? 0) > 0) {
      return {
        balanceVerified: true,
        totalBalance,
        availableBalance
      };
    }

    if (attempt < TEST_FUNDS_BALANCE_POLL_ATTEMPTS) {
      await sleep(TEST_FUNDS_BALANCE_POLL_DELAY_MS);
    }
  }

  return {
    balanceVerified: false,
    totalBalance: lastTotalBalance,
    availableBalance: lastAvailableBalance
  };
}

function normalizeBalanceValue(value: number | undefined): number | null {
  return Number.isFinite(value) ? value ?? null : null;
}

function isAlreadyClaimedFaucetMessage(message: string): boolean {
  const text = message.toLowerCase();
  return text.includes("faucet can only be used once per 24 hours")
    || text.includes("already funded")
    || text.includes("already claimed");
}

function getPositionSymbol(position: Position): string {
  const symbol = position.symbol ?? position.coin;
  if (!symbol) {
    fail(`Unexpected position payload: ${JSON.stringify(position)}`);
  }
  return symbol;
}

async function executeBatchOrder(input: {
  side: "buy" | "sell";
  symbol: string;
  sizeOrPercent: string;
  options: BatchCommandOptions & { price?: string; tif?: OrderTimeInForce };
}): Promise<void> {
  const config = loadConfig();
  configureNetworking(config);
  const filePath = resolveWalletFile(input.options.file ?? ".wallets.json");
  const profiles = loadWalletProfiles(filePath).filter((item) => item.enabled !== false);
  const proxies = resolveBatchProxies(input.options, profiles.length);
  const api = new BulkApiClient(config.apiBaseUrl);
  const plan = getBatchPlan(profiles.length, input.options.delayMs, input.options.jitterMs);
  const results: Array<Record<string, unknown>> = [];
  const normalizedSymbol = normalizeSymbol(input.symbol);

  console.log(`[batch-${input.side}] wallets=${profiles.length}, symbol=${normalizedSymbol}, requested=${input.sizeOrPercent}, file=${filePath}`);

  for (let index = 0; index < profiles.length; index += 1) {
    const profile = profiles[index];
    const proxyUrl = proxies[index];
    configureNetworking(config, proxyUrl);
    logBatchProgress(input.side, index, profiles.length, profile.name, plan[index]);

    if (input.options.dryRun) {
      results.push({
        name: profile.name,
        scheduledAfterMs: plan[index],
        action: input.side,
        symbol: normalizeSymbol(input.symbol),
        requested: input.sizeOrPercent
      });
      continue;
    }

    if (plan[index] > 0) {
      await sleep(plan[index]);
    }

    try {
      const orderResult = await submitOrderForProfile(api, profile, {
        side: input.side,
        symbol: input.symbol,
        sizeOrPercent: input.sizeOrPercent,
        options: {
          price: input.options.price,
          tif: input.options.tif,
          leverage: input.options.leverage
        }
      });

        results.push({
        ok: true,
        name: profile.name,
        account: profile.accountAddress,
        proxyUsed: maskProxyUrl(proxyUrl ?? config.proxyUrl),
        scheduledAfterMs: plan[index],
        ...orderResult
      });
        console.log(`[${input.side} ok] ${profile.name} -> ${normalizedSymbol}`);
    } catch (error) {
      results.push({
        ok: false,
        name: profile.name,
        account: profile.accountAddress,
        proxyUsed: maskProxyUrl(proxyUrl ?? config.proxyUrl),
        scheduledAfterMs: plan[index],
        symbol: normalizedSymbol,
        requested: input.sizeOrPercent,
        error: formatError(error)
      });
      console.log(`[${input.side} error] ${profile.name}: ${formatError(error)}`);
    }
  }

  const failed = results.some((item) => item.ok === false);
  console.log(JSON.stringify({
    ok: !failed,
    file: filePath,
    wallets: results
  }, null, 2));
}

async function connectWalletProfile(
  api: BulkApiClient,
  profile: WalletProfile,
  options: {
    skipFaucet: boolean;
    skipMaxLeverage: boolean;
  }
): Promise<{ profile: WalletProfile; testFunds: TestFundsResult }> {
  const ownerKeypair = loadKeypair(profile.ownerSecretKey);
  const existingAgentKeypair = profile.agentSecretKey ? loadKeypair(profile.agentSecretKey) : undefined;
  const agentKeypair =
    existingAgentKeypair && existingAgentKeypair.pubkey !== ownerKeypair.pubkey
      ? existingAgentKeypair
      : createKeypair();

  const authResponse = await api.submit(signAgentWalletAction({
    account: ownerKeypair.pubkey,
    signerKeypair: ownerKeypair,
    nonce: nextNonce(),
    agentPubkey: agentKeypair.pubkey,
    deleteFlag: false
  }));

  try {
    ensureAcceptedStatuses(authResponse, "agent wallet registration");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("agent wallet already exists")) {
      throw error;
    }
  }

  if (!options.skipMaxLeverage) {
    const exchangeInfo = await api.getExchangeInfo();
    const settingsResponse = await api.submit(signUserSettingsAction({
      account: ownerKeypair.pubkey,
      signerKeypair: ownerKeypair,
      nonce: nextNonce(),
      leverageMap: Object.fromEntries(exchangeInfo.map((item) => [item.symbol, item.maxLeverage]))
    }));
    ensureAcceptedStatuses(settingsResponse, "max leverage setup");
  }

  const testFunds = await ensureTestFundsReady(api, ownerKeypair, options.skipFaucet);

  return {
    profile: {
      ...profile,
      accountAddress: ownerKeypair.pubkey,
      agentPublicKey: agentKeypair.pubkey,
      agentSecretKey: agentKeypair.toBase58()
    },
    testFunds
  };
}

async function submitOrderForProfile(
  api: BulkApiClient,
  profile: WalletProfile,
  input: {
    side: "buy" | "sell";
    symbol: string;
    sizeOrPercent: string;
    options: { price?: string; tif?: OrderTimeInForce; leverage?: string };
  }
): Promise<Record<string, unknown>> {
  if (!profile.accountAddress || !profile.agentSecretKey) {
    throw new Error(`Wallet "${profile.name}" is not connected. Run batch-connect first.`);
  }

  const identity: TradingIdentity = {
    accountAddress: profile.accountAddress,
    keypair: loadKeypair(profile.agentSecretKey)
  };

  const symbol = normalizeSymbol(input.symbol);
  const exchangeInfo = await api.getExchangeInfo();
  await ensureLeverage(
    api,
    {
      apiBaseUrl: "",
      accountAddress: profile.accountAddress,
      ownerSecretKey: undefined,
      agentSecretKey: profile.agentSecretKey,
      agentPublicKey: profile.agentPublicKey,
      defaultLeverage: undefined,
      envPath: "",
      secretsEnvPath: ""
    },
    identity,
    symbol,
    exchangeInfo,
    input.options.leverage
  );

  const account = await api.getFullAccount(identity.accountAddress);
  const size = await resolveOrderSize({
    api,
    symbol,
    sizeOrPercent: input.sizeOrPercent,
    exchangeInfo,
    account,
    leverageOverride: input.options.leverage
  });

  const isLimit = input.options.price !== undefined;
  const price = isLimit ? Number(input.options.price) : 0;

  if (isLimit && (!Number.isFinite(price) || price <= 0)) {
    throw new Error("Limit order requires a positive --price.");
  }

  const response = await api.submit(signOrderActions({
    account: identity.accountAddress,
    signerKeypair: identity.keypair,
    nonce: nextNonce(),
    actions: [
      isLimit
        ? {
            l: {
              c: symbol,
              b: input.side === "buy",
              px: price,
              sz: size.size,
              tif: (input.options.tif ?? "GTC").toUpperCase() as OrderTimeInForce,
              r: false
            }
          }
        : {
            m: {
              c: symbol,
              b: input.side === "buy",
              sz: size.size,
              r: false
            }
          }
    ]
  }));

  return {
    symbol,
    side: input.side,
    requested: input.sizeOrPercent,
    size: size.size,
    sizingMode: size.mode,
    percentOfAvailableBalance: size.percentOfAvailableBalance,
    referencePrice: size.referencePrice,
    leverage: size.leverage,
    estimatedMarginUsed: size.estimatedMarginUsed,
    estimatedNotional: size.estimatedNotional,
    orderType: isLimit ? "limit" : "market",
    price: isLimit ? price : null,
    statuses: ensureAcceptedStatuses(response, `${input.side} ${symbol}`)
  };
}

async function closeWalletSymbol(
  api: BulkApiClient,
  profile: WalletProfile,
  symbol: string
): Promise<Record<string, unknown>> {
  if (!profile.accountAddress || !profile.agentSecretKey) {
    throw new Error(`Wallet "${profile.name}" is not connected. Run batch-connect first.`);
  }

  const identity: TradingIdentity = {
    accountAddress: profile.accountAddress,
    keypair: loadKeypair(profile.agentSecretKey)
  };

  const account = await api.getFullAccount(identity.accountAddress);
  const position = account.positions.find((item) => getPositionSymbol(item) === symbol);

  if (!position || !position.size) {
    return {
      symbol,
      message: "No open position."
    };
  }

  const response = await api.submit(signOrderActions({
    account: identity.accountAddress,
    signerKeypair: identity.keypair,
    nonce: nextNonce(),
    actions: [
      {
        m: {
          c: symbol,
          b: position.size < 0,
          sz: Math.abs(position.size),
          r: true
        }
      }
    ]
  }));

  return {
    symbol,
    closedSize: Math.abs(position.size),
    statuses: ensureAcceptedStatuses(response, `close ${symbol}`)
  };
}

function getBatchPlan(length: number, delayMsRaw: string | undefined, jitterMsRaw: string | undefined): number[] {
  const delayMs = Number(delayMsRaw ?? "0");
  const jitterMs = Number(jitterMsRaw ?? "0");

  if (!Number.isFinite(delayMs) || delayMs < 0 || !Number.isFinite(jitterMs) || jitterMs < 0) {
    throw new Error("delay-ms and jitter-ms must be non-negative numbers.");
  }

  const plan: number[] = [];

  for (let index = 0; index < length; index += 1) {
    if (index === 0) {
      plan.push(0);
      continue;
    }

    plan.push(delayMs + Math.floor(Math.random() * (jitterMs + 1)));
  }

  return plan;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function retryBatchConnect<T>(walletName: string, action: (attempt: number) => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= BATCH_CONNECT_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await action(attempt);
    } catch (error) {
      lastError = error;

      if (attempt >= BATCH_CONNECT_RETRY_ATTEMPTS || !isRetryableConnectError(error)) {
        throw error;
      }

      const delayMs = randomInt(BATCH_CONNECT_RETRY_DELAY_MIN_MS, BATCH_CONNECT_RETRY_DELAY_MAX_MS);
      console.log(`[connect retry wait] ${walletName} ${delayMs}ms: ${formatError(error)}`);
      await sleep(delayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isRetryableConnectError(error: unknown): boolean {
  const message = formatError(error).toLowerCase();

  return (
    message.includes("http 408") ||
    message.includes("http 425") ||
    message.includes("http 429") ||
    message.includes("http 500") ||
    message.includes("http 502") ||
    message.includes("http 503") ||
    message.includes("http 504") ||
    message.includes("fetch failed") ||
    message.includes("timeout") ||
    message.includes("socket")
  );
}

function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function resolveBatchProxies(options: BatchCommandOptions, walletCount: number): Array<string | undefined> {
  const proxiesFile = options.proxiesFile ?? ".proxies.txt";
  const resolved = resolveWalletFile(proxiesFile);

  if (!fs.existsSync(resolved)) {
    return new Array<string | undefined>(walletCount).fill(undefined);
  }

  const proxies = loadProxyLines(resolved);

  if (proxies.length === 0) {
    return new Array<string | undefined>(walletCount).fill(undefined);
  }

  return Array.from({ length: walletCount }, (_, index) => proxies[index % proxies.length]);
}

function maskProxyUrl(proxyUrl?: string | null): string | null {
  const normalized = normalizeProxyUrlInput(proxyUrl);

  if (!normalized) {
    return null;
  }

  try {
    const url = new URL(normalized);

    if (url.username) {
      url.username = "***";
    }

    if (url.password) {
      url.password = "***";
    }

    return url.toString();
  } catch {
    return normalized.replace(/\/\/([^@]+)@/, "//***:***@");
  }
}

function logBatchProgress(action: string, index: number, total: number, walletName: string, delayMs: number): void {
  if (delayMs > 0) {
    console.log(`[${action} ${index + 1}/${total}] ${walletName} waiting ${delayMs}ms`);
    return;
  }

  console.log(`[${action} ${index + 1}/${total}] ${walletName} starting`);
}

function fail(message: string): never {
  throw new Error(message);
}
