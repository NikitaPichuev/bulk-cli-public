#!/usr/bin/env node
import fs from "fs";
import { Command } from "commander";

import { getOrCreateAccountActivity, loadActivityState, resolveActivityStateFile, saveActivityState, type ActivityRunRecord } from "./activityState";
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

interface DailyCycleCommandOptions {
  stateFile?: string;
  symbols?: string;
  minTrades?: string;
  maxTrades?: string;
  sizeRange?: string;
  leverage?: string;
  minHoldMinutes?: string;
  maxHoldMinutes?: string;
  minWaitMinutes?: string;
  maxWaitMinutes?: string;
  limitProbability?: string;
  limitOffsetBps?: string;
  dryRun?: boolean;
}

interface BatchDailyCycleCommandOptions extends DailyCycleCommandOptions {
  file?: string;
  proxiesFile?: string;
  delayMs?: string;
  jitterMs?: string;
  concurrency?: string;
  wallets?: string;
  maxWallets?: string;
  shuffleWallets?: boolean;
}

interface DailyCycleSettings {
  stateFile: string;
  symbols: string[];
  minTrades: number;
  maxTrades: number;
  sizeRange: string;
  leverage: string;
  minHoldMinutes: number;
  maxHoldMinutes: number;
  minWaitMinutes: number;
  maxWaitMinutes: number;
  limitProbability: number;
  limitOffsetBps: number;
  timezone: string;
}

interface PlannedDailyTrade {
  index: number;
  side: "buy" | "sell";
  symbol: string;
  sizeOrPercent: string;
  orderType: "market" | "limit";
  holdMs: number;
  waitBeforeMs: number;
  limitOffsetBps: number | null;
}

interface DailyCycleRunResult {
  ok: boolean;
  account: string;
  localDate: string;
  timezone: string;
  stateFile: string;
  activeDays: {
    streak: number;
    lastActiveDate?: string;
  };
  run: ActivityRunRecord;
  trades: Array<Record<string, unknown>>;
}

interface DailyCycleDryRunResult {
  ok: true;
  dryRun: true;
  account: string;
  localDate: string;
  timezone: string;
  stateFile: string;
  faucetAttemptPlanned: true;
  settings: DailyCycleSettings;
  trades: Array<Record<string, unknown>>;
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
  .command("daily-cycle")
  .description("Run a randomized daily trading routine for the configured account and track active days")
  .option("--state-file <path>", "Local JSON state file for faucet/activity tracking", ".activity-state.json")
  .option("--symbols <list>", "Comma-separated symbols, for example BTC,ETH,SOL", "BTC,ETH,SOL")
  .option("--min-trades <count>", "Minimum number of trades in this run", "3")
  .option("--max-trades <count>", "Maximum number of trades in this run", "8")
  .option("--size-range <range>", "Percent range per trade, for example 12-28%", "12-28%")
  .option("--leverage <value>", "Leverage to set before routine trades", "2")
  .option("--min-hold-minutes <minutes>", "Minimum hold time per position", "5")
  .option("--max-hold-minutes <minutes>", "Maximum hold time per position", "30")
  .option("--min-wait-minutes <minutes>", "Minimum wait between trades", "15")
  .option("--max-wait-minutes <minutes>", "Maximum wait between trades", "90")
  .option("--limit-probability <percent>", "How often to use limit orders instead of market orders", "40")
  .option("--limit-offset-bps <bps>", "Aggressive limit offset in basis points", "8")
  .option("--dry-run", "Print the planned routine without sending orders", false)
  .action(async (options: DailyCycleCommandOptions) => {
    await runDailyCycle(options);
  });

program
  .command("batch-daily-cycle")
  .description("Run the randomized daily trading routine for a batch wallet file")
  .option("--file <path>", "Wallets JSON file", ".wallets.json")
  .option("--proxies-file <path>", "Optional proxies text file, one proxy per line", ".proxies.txt")
  .option("--delay-ms <ms>", "Base delay between wallets in milliseconds", "5000")
  .option("--jitter-ms <ms>", "Random extra delay between wallets in milliseconds", "5000")
  .option("--concurrency <count>", "How many wallets to process in parallel", "3")
  .option("--wallets <list>", "Comma-separated wallet names to include, for example wallet-1,wallet-7")
  .option("--max-wallets <count>", "Maximum number of wallets to process in this run")
  .option("--shuffle-wallets", "Shuffle wallet order before applying max-wallets", false)
  .option("--state-file <path>", "Local JSON state file for faucet/activity tracking", ".activity-state.json")
  .option("--symbols <list>", "Comma-separated symbols, for example BTC,ETH,SOL", "BTC,ETH,SOL")
  .option("--min-trades <count>", "Minimum number of trades in this run", "3")
  .option("--max-trades <count>", "Maximum number of trades in this run", "8")
  .option("--size-range <range>", "Percent range per trade, for example 12-28%", "12-28%")
  .option("--leverage <value>", "Leverage to set before routine trades", "2")
  .option("--min-hold-minutes <minutes>", "Minimum hold time per position", "5")
  .option("--max-hold-minutes <minutes>", "Maximum hold time per position", "30")
  .option("--min-wait-minutes <minutes>", "Minimum wait between trades", "15")
  .option("--max-wait-minutes <minutes>", "Maximum wait between trades", "90")
  .option("--limit-probability <percent>", "How often to use limit orders instead of market orders", "40")
  .option("--limit-offset-bps <bps>", "Aggressive limit offset in basis points", "8")
  .option("--dry-run", "Print the planned routines without sending orders", false)
  .action(async (options: BatchDailyCycleCommandOptions) => {
    await runBatchDailyCycle(options);
  });

program
  .command("batch-connect")
  .description("Connect a JSON list of wallets, create/register agent wallets, and persist them back to the file")
  .option("--file <path>", "Wallets JSON file", ".wallets.json")
  .option("--proxies-file <path>", "Optional proxies text file, one proxy per line", ".proxies.txt")
  .option("--delay-ms <ms>", "Base delay between wallets in milliseconds", "5000")
  .option("--jitter-ms <ms>", "Random extra delay between wallets in milliseconds", "5000")
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
  .option("--delay-ms <ms>", "Base delay between wallets in milliseconds", "5000")
  .option("--jitter-ms <ms>", "Random extra delay between wallets in milliseconds", "5000")
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
  .option("--delay-ms <ms>", "Base delay between wallets in milliseconds", "5000")
  .option("--jitter-ms <ms>", "Random extra delay between wallets in milliseconds", "5000")
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
  .option("--delay-ms <ms>", "Base delay between wallets in milliseconds", "5000")
  .option("--jitter-ms <ms>", "Random extra delay between wallets in milliseconds", "5000")
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

async function runDailyCycle(options: DailyCycleCommandOptions): Promise<void> {
  const config = loadConfig();
  configureNetworking(config);
  const api = new BulkApiClient(config.apiBaseUrl);
  const identity = requireTradingIdentity(config);
  const exchangeInfo = await api.getExchangeInfo();
  const settings = resolveDailyCycleSettings(options, exchangeInfo);
  const result = await runDailyCycleForIdentity({
    api,
    config,
    identity,
    exchangeInfo,
    settings,
    dryRun: options.dryRun ?? false,
    logPrefix: "daily-cycle"
  });

  console.log(JSON.stringify(result, null, 2));
}

async function runBatchDailyCycle(options: BatchDailyCycleCommandOptions): Promise<void> {
  const config = loadConfig();
  configureNetworking(config);
  const api = new BulkApiClient(config.apiBaseUrl, config.proxyUrl);
  const exchangeInfo = await api.getExchangeInfo();
  const settings = resolveDailyCycleSettings(options, exchangeInfo);
  const filePath = resolveWalletFile(options.file ?? ".wallets.json");
  const allProfiles = loadWalletProfiles(filePath).filter((item) => item.enabled !== false);
  const proxies = resolveBatchProxies(options, allProfiles.length);
  const selectedProfiles = selectBatchDailyCycleProfiles(allProfiles, options);
  const walletPlan = getBatchPlan(selectedProfiles.length, options.delayMs, options.jitterMs);
  const concurrency = parsePositiveIntegerOption(options.concurrency ?? "3", "concurrency");
  const results = new Array<Record<string, unknown>>(selectedProfiles.length);
  let nextIndex = 0;

  console.log(`[batch-daily-cycle] wallets=${selectedProfiles.length}, file=${filePath}, concurrency=${concurrency}`);

  const workerCount = Math.min(concurrency, selectedProfiles.length);

  await Promise.all(Array.from({ length: workerCount }, (_, workerIndex) => runBatchDailyCycleWorker({
    workerIndex,
    getNextIndex: () => {
      if (nextIndex >= selectedProfiles.length) {
        return null;
      }

      const current = nextIndex;
      nextIndex += 1;
      return current;
    },
    selectedProfiles,
    proxies,
    walletPlan,
    exchangeInfo,
    settings,
    options,
    config,
    results
  })));

  console.log(JSON.stringify({
    ok: results.every((item) => item?.ok === true),
    dryRun: options.dryRun ?? false,
    file: filePath,
    wallets: results
  }, null, 2));
}

async function runBatchDailyCycleWorker(input: {
  workerIndex: number;
  getNextIndex: () => number | null;
  selectedProfiles: Array<{ profile: WalletProfile; originalIndex: number }>;
  proxies: Array<string | undefined>;
  walletPlan: number[];
  exchangeInfo: ExchangeSymbolInfo[];
  settings: DailyCycleSettings;
  options: BatchDailyCycleCommandOptions;
  config: EnvConfig;
  results: Array<Record<string, unknown>>;
}): Promise<void> {
  while (true) {
    const index = input.getNextIndex();

    if (index === null) {
      return;
    }

    const selected = input.selectedProfiles[index];
    const profile = selected.profile;
    const proxyUrl = input.proxies[selected.originalIndex];
    const walletApi = new BulkApiClient(input.config.apiBaseUrl, proxyUrl ?? input.config.proxyUrl);
    const workerLabel = `worker-${input.workerIndex + 1}`;
    const logAction = `${workerLabel}/daily-cycle`;

    logBatchProgress(logAction, index, input.selectedProfiles.length, profile.name, input.walletPlan[index]);

    if (input.walletPlan[index] > 0 && !input.options.dryRun) {
      await sleep(input.walletPlan[index]);
    }

    if (!profile.accountAddress || !profile.agentSecretKey) {
      input.results[index] = {
        ok: false,
        name: profile.name,
        account: profile.accountAddress,
        proxyUsed: maskProxyUrl(proxyUrl ?? input.config.proxyUrl),
        scheduledAfterMs: input.walletPlan[index],
        worker: input.workerIndex + 1,
        error: `Wallet "${profile.name}" is not connected. Run batch-connect first.`
      };
      console.log(`[batch-daily-cycle error] ${profile.name}: not connected`);
      continue;
    }

    const identity: TradingIdentity = {
      accountAddress: profile.accountAddress,
      keypair: loadKeypair(profile.agentSecretKey)
    };

    try {
      const result = await runDailyCycleForIdentity({
        api: walletApi,
        config: input.config,
        identity,
        exchangeInfo: input.exchangeInfo,
        settings: input.settings,
        dryRun: input.options.dryRun ?? false,
        logPrefix: `${workerLabel}/${profile.name}/daily-cycle`
      });

      input.results[index] = {
        ok: result.ok,
        name: profile.name,
        account: profile.accountAddress,
        proxyUsed: maskProxyUrl(proxyUrl ?? input.config.proxyUrl),
        scheduledAfterMs: input.walletPlan[index],
        worker: input.workerIndex + 1,
        result
      };
      if ("activeDays" in result) {
        console.log(`[batch-daily-cycle ok] ${profile.name} -> worker=${input.workerIndex + 1}, streak=${result.activeDays.streak}`);
      } else {
        console.log(`[batch-daily-cycle ok] ${profile.name} -> worker=${input.workerIndex + 1}, dry-run`);
      }
    } catch (error) {
      input.results[index] = {
        ok: false,
        name: profile.name,
        account: profile.accountAddress,
        proxyUsed: maskProxyUrl(proxyUrl ?? input.config.proxyUrl),
        scheduledAfterMs: input.walletPlan[index],
        worker: input.workerIndex + 1,
        error: formatError(error)
      };
      console.log(`[batch-daily-cycle error] ${profile.name}: ${formatError(error)}`);
    }
  }
}

async function runDailyCycleForIdentity(input: {
  api: BulkApiClient;
  config: EnvConfig;
  identity: TradingIdentity;
  exchangeInfo: ExchangeSymbolInfo[];
  settings: DailyCycleSettings;
  dryRun: boolean;
  logPrefix: string;
}): Promise<DailyCycleRunResult | DailyCycleDryRunResult> {
  const localDate = getLocalDateString(new Date(), input.settings.timezone);
  const plan = buildDailyTradePlan(input.settings);
  const statePath = resolveActivityStateFile(input.settings.stateFile);
  const summaryTrades: Array<Record<string, unknown>> = [];

  console.log(`[${input.logPrefix}] account=${input.identity.accountAddress}, trades=${plan.length}, state=${statePath}`);

  if (input.dryRun) {
    return {
      ok: true,
      dryRun: true,
      account: input.identity.accountAddress,
      localDate,
      timezone: input.settings.timezone,
      stateFile: statePath,
      faucetAttemptPlanned: true,
      settings: input.settings,
      trades: plan.map((trade) => ({
        index: trade.index,
        symbol: trade.symbol,
        side: trade.side,
        sizeOrPercent: trade.sizeOrPercent,
        orderType: trade.orderType,
        holdMinutes: Math.round(trade.holdMs / 60_000),
        waitBeforeMinutes: Math.round(trade.waitBeforeMs / 60_000),
        limitOffsetBps: trade.limitOffsetBps
      }))
    };
  }

  const state = loadActivityState(statePath, input.settings.timezone);
  state.timezone = input.settings.timezone;
  const accountState = getOrCreateAccountActivity(state, input.identity.accountAddress);
  const runRecord: ActivityRunRecord = {
    startedAt: new Date().toISOString(),
    localDate,
    tradesPlanned: plan.length,
    tradesCompleted: 0,
    tradesFailed: 0
  };

  if (accountState.lastFaucetAttemptDate !== localDate) {
    console.log(`[${input.logPrefix}] faucet check starting`);
    const testFunds = await ensureTestFundsReady(input.api, input.identity.keypair, false, input.identity.accountAddress);
    accountState.lastFaucetAttemptDate = localDate;
    runRecord.faucetStatus = testFunds.faucetStatus;
    saveActivityState(statePath, state);
  } else {
    runRecord.faucetStatus = "skipped_same_day";
    console.log(`[${input.logPrefix}] faucet already attempted today, skipping`);
  }

  for (const trade of plan) {
    if (trade.waitBeforeMs > 0) {
      console.log(`[${input.logPrefix}] wait before trade ${trade.index}/${plan.length}: ${trade.waitBeforeMs}ms`);
      await sleep(trade.waitBeforeMs);
    }

    try {
      console.log(`[${input.logPrefix}] trade ${trade.index}/${plan.length}: ${trade.side} ${trade.symbol} ${trade.sizeOrPercent} (${trade.orderType})`);
      const result = await executeDailyTrade(input.api, input.config, input.identity, input.exchangeInfo, trade, input.settings.leverage);
      summaryTrades.push({
        ok: true,
        ...result
      });
      runRecord.tradesCompleted += 1;
      accountState.totalTradesCompleted += 1;
      markAccountActiveDay(accountState, localDate);
      saveActivityState(statePath, state);
    } catch (error) {
      const message = formatError(error);
      summaryTrades.push({
        ok: false,
        index: trade.index,
        symbol: trade.symbol,
        side: trade.side,
        sizeOrPercent: trade.sizeOrPercent,
        orderType: trade.orderType,
        error: message
      });
      runRecord.tradesFailed += 1;
      console.log(`[${input.logPrefix} error] trade ${trade.index}: ${message}`);
      saveActivityState(statePath, state);
    }
  }

  runRecord.completedAt = new Date().toISOString();
  accountState.lastRunAt = runRecord.completedAt;
  accountState.totalRoutineRuns += 1;
  accountState.recentRuns = [runRecord, ...accountState.recentRuns].slice(0, 30);
  saveActivityState(statePath, state);

  return {
    ok: runRecord.tradesCompleted > 0 && runRecord.tradesFailed === 0,
    account: input.identity.accountAddress,
    localDate,
    timezone: input.settings.timezone,
    stateFile: statePath,
    activeDays: {
      streak: accountState.activeDaysStreak,
      lastActiveDate: accountState.lastActiveDate
    },
    run: runRecord,
    trades: summaryTrades
  };
}

function resolveDailyCycleSettings(
  options: DailyCycleCommandOptions,
  exchangeInfo: ExchangeSymbolInfo[]
): DailyCycleSettings {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const symbols = parseDailySymbols(options.symbols ?? "BTC,ETH,SOL", exchangeInfo);
  const minTrades = parsePositiveIntegerOption(options.minTrades ?? "3", "min-trades");
  const maxTrades = parsePositiveIntegerOption(options.maxTrades ?? "8", "max-trades");
  const minHoldMinutes = parsePositiveIntegerOption(options.minHoldMinutes ?? "5", "min-hold-minutes");
  const maxHoldMinutes = parsePositiveIntegerOption(options.maxHoldMinutes ?? "30", "max-hold-minutes");
  const minWaitMinutes = parsePositiveIntegerOption(options.minWaitMinutes ?? "15", "min-wait-minutes");
  const maxWaitMinutes = parsePositiveIntegerOption(options.maxWaitMinutes ?? "90", "max-wait-minutes");
  const leverage = options.leverage?.trim() || "2";
  const limitProbability = parsePercentageOption(options.limitProbability ?? "40", "limit-probability");
  const limitOffsetBps = parsePositiveIntegerOption(options.limitOffsetBps ?? "8", "limit-offset-bps");
  const sizeRange = normalizePercentSizingInput(options.sizeRange ?? "12-28%");

  if (minTrades > maxTrades) {
    fail("min-trades must be less than or equal to max-trades.");
  }

  if (minHoldMinutes > maxHoldMinutes) {
    fail("min-hold-minutes must be less than or equal to max-hold-minutes.");
  }

  if (minWaitMinutes > maxWaitMinutes) {
    fail("min-wait-minutes must be less than or equal to max-wait-minutes.");
  }

  return {
    stateFile: options.stateFile ?? ".activity-state.json",
    symbols,
    minTrades,
    maxTrades,
    sizeRange,
    leverage,
    minHoldMinutes,
    maxHoldMinutes,
    minWaitMinutes,
    maxWaitMinutes,
    limitProbability,
    limitOffsetBps,
    timezone
  };
}

function buildDailyTradePlan(settings: DailyCycleSettings): PlannedDailyTrade[] {
  const tradeCount = randomInt(settings.minTrades, settings.maxTrades);
  const sides = buildDailySides(tradeCount);
  const orderTypes = buildDailyOrderTypes(tradeCount, settings.limitProbability);
  const symbols = buildDailySymbols(tradeCount, settings.symbols);

  return Array.from({ length: tradeCount }, (_, index) => ({
    index: index + 1,
    side: sides[index],
    symbol: symbols[index],
    sizeOrPercent: drawPercentSizingInput(settings.sizeRange),
    orderType: orderTypes[index],
    holdMs: randomInt(settings.minHoldMinutes, settings.maxHoldMinutes) * 60_000,
    waitBeforeMs: index === 0 ? 0 : randomInt(settings.minWaitMinutes, settings.maxWaitMinutes) * 60_000,
    limitOffsetBps: orderTypes[index] === "limit" ? settings.limitOffsetBps : null
  }));
}

function buildDailySides(tradeCount: number): Array<"buy" | "sell"> {
  if (tradeCount === 1) {
    return [Math.random() >= 0.5 ? "buy" : "sell"];
  }

  const sides: Array<"buy" | "sell"> = ["buy", "sell"];

  while (sides.length < tradeCount) {
    sides.push(Math.random() >= 0.5 ? "buy" : "sell");
  }

  return shuffleArray(sides);
}

function buildDailyOrderTypes(tradeCount: number, limitProbability: number): Array<"market" | "limit"> {
  if (tradeCount === 1) {
    return [Math.random() * 100 < limitProbability ? "limit" : "market"];
  }

  const orderTypes: Array<"market" | "limit"> = ["market", "limit"];

  while (orderTypes.length < tradeCount) {
    orderTypes.push(Math.random() * 100 < limitProbability ? "limit" : "market");
  }

  return shuffleArray(orderTypes);
}

function buildDailySymbols(tradeCount: number, symbols: string[]): string[] {
  if (symbols.length === 1) {
    return new Array<string>(tradeCount).fill(symbols[0]);
  }

  const ordered = shuffleArray(symbols);
  const selected: string[] = [];

  for (let index = 0; index < tradeCount; index += 1) {
    const previous = selected.at(-1);
    const candidates = ordered.filter((symbol) => symbol !== previous);
    const source = candidates.length > 0 ? candidates : ordered;
    selected.push(source[index % source.length]);
  }

  return selected;
}

async function executeDailyTrade(
  api: BulkApiClient,
  config: EnvConfig,
  identity: TradingIdentity,
  exchangeInfo: ExchangeSymbolInfo[],
  trade: PlannedDailyTrade,
  leverage: string
): Promise<Record<string, unknown>> {
  await cleanupSymbolState(api, identity, trade.symbol);
  await ensureLeverage(api, config, identity, trade.symbol, exchangeInfo, leverage);

  const account = await api.getFullAccount(identity.accountAddress);
  const size = await resolveOrderSize({
    api,
    symbol: trade.symbol,
    sizeOrPercent: trade.sizeOrPercent,
    exchangeInfo,
    account,
    leverageOverride: leverage
  });

  let actualOrderType: "market" | "limit" | "limit_fallback_market" = trade.orderType;
  let limitPrice: number | null = null;
  let openStatuses: Array<Record<string, unknown>>;

  if (trade.orderType === "limit") {
    const symbolInfo = exchangeInfo.find((item) => item.symbol === trade.symbol);

    if (!symbolInfo) {
      throw new Error(`Unknown symbol in daily cycle: ${trade.symbol}`);
    }

    const referencePrice = size.referencePrice ?? await api.getReferencePrice(trade.symbol);
    limitPrice = computeAggressiveLimitPrice(referencePrice, trade.side, trade.limitOffsetBps ?? 0, symbolInfo.tickSize);
    const limitResponse = await api.submit(signOrderActions({
      account: identity.accountAddress,
      signerKeypair: identity.keypair,
      nonce: nextNonce(),
      actions: [
        {
          l: {
            c: trade.symbol,
            b: trade.side === "buy",
            px: limitPrice,
            sz: size.size,
            tif: "GTC",
            r: false
          }
        }
      ]
    }));
    openStatuses = ensureAcceptedStatuses(limitResponse, `${trade.side} ${trade.symbol} limit`);

    const filledPosition = await waitForPosition(api, identity.accountAddress, trade.symbol, 20_000);

    if (!filledPosition || Math.abs(filledPosition.size) <= 0) {
      await cancelAllOrdersForSymbols(api, identity, [trade.symbol]);
      const fallbackResponse = await api.submit(signOrderActions({
        account: identity.accountAddress,
        signerKeypair: identity.keypair,
        nonce: nextNonce(),
        actions: [
          {
            m: {
              c: trade.symbol,
              b: trade.side === "buy",
              sz: size.size,
              r: false
            }
          }
        ]
      }));
      openStatuses = [...openStatuses, ...ensureAcceptedStatuses(fallbackResponse, `${trade.side} ${trade.symbol} market fallback`)];
      actualOrderType = "limit_fallback_market";
    }
  } else {
    const response = await api.submit(signOrderActions({
      account: identity.accountAddress,
      signerKeypair: identity.keypair,
      nonce: nextNonce(),
      actions: [
        {
          m: {
            c: trade.symbol,
            b: trade.side === "buy",
            sz: size.size,
            r: false
          }
        }
      ]
    }));
    openStatuses = ensureAcceptedStatuses(response, `${trade.side} ${trade.symbol} market`);
  }

  const openedPosition = await waitForPosition(api, identity.accountAddress, trade.symbol, 20_000);

  if (!openedPosition || Math.abs(openedPosition.size) <= 0) {
    throw new Error(`Failed to observe an open position for ${trade.symbol}.`);
  }

  console.log(`[daily-cycle] holding ${trade.symbol} for ${trade.holdMs}ms`);
  await sleep(trade.holdMs);

  const closeResult = await closeSymbolForIdentity(api, identity, trade.symbol);
  await cancelAllOrdersForSymbols(api, identity, [trade.symbol]);
  const closed = await waitForClosedPosition(api, identity.accountAddress, trade.symbol, 20_000);

  return {
    index: trade.index,
    symbol: trade.symbol,
    side: trade.side,
    requested: trade.sizeOrPercent,
    openedSize: Math.abs(openedPosition.size),
    requestedSize: size.size,
    sizingMode: size.mode,
    leverage: size.leverage,
    estimatedNotional: size.estimatedNotional,
    estimatedMarginUsed: size.estimatedMarginUsed,
    orderTypeRequested: trade.orderType,
    orderTypeExecuted: actualOrderType,
    limitPrice,
    holdMinutes: Math.round(trade.holdMs / 60_000),
    openStatuses,
    closeStatuses: closeResult.statuses,
    closed: closed
  };
}

async function cleanupSymbolState(
  api: BulkApiClient,
  identity: TradingIdentity,
  symbol: string
): Promise<void> {
  const account = await api.getFullAccount(identity.accountAddress);
  const hasOpenOrders = account.openOrders.some((item) => item.symbol === symbol);
  const position = account.positions.find((item) => getPositionSymbol(item) === symbol);

  if (hasOpenOrders) {
    await cancelAllOrdersForSymbols(api, identity, [symbol]);
  }

  if (position && Math.abs(position.size) > 0) {
    await closeSymbolForIdentity(api, identity, symbol);
    await waitForClosedPosition(api, identity.accountAddress, symbol, 20_000);
  }
}

async function closeSymbolForIdentity(
  api: BulkApiClient,
  identity: TradingIdentity,
  symbol: string
): Promise<{ statuses: Array<Record<string, unknown>>; closedSize: number }> {
  const account = await api.getFullAccount(identity.accountAddress);
  const position = account.positions.find((item) => getPositionSymbol(item) === symbol);

  if (!position || Math.abs(position.size) <= 0) {
    return {
      statuses: [],
      closedSize: 0
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
    statuses: ensureAcceptedStatuses(response, `close ${symbol}`),
    closedSize: Math.abs(position.size)
  };
}

async function cancelAllOrdersForSymbols(
  api: BulkApiClient,
  identity: TradingIdentity,
  symbols: string[]
): Promise<Array<Record<string, unknown>>> {
  const uniqueSymbols = Array.from(new Set(symbols.filter(Boolean)));

  if (uniqueSymbols.length === 0) {
    return [];
  }

  const response = await api.submit(signOrderActions({
    account: identity.accountAddress,
    signerKeypair: identity.keypair,
    nonce: nextNonce(),
    actions: [
      {
        cxa: {
          c: uniqueSymbols
        }
      }
    ]
  }));

  return ensureAcceptedStatuses(response, `cancel all ${uniqueSymbols.join(",")}`);
}

async function waitForPosition(
  api: BulkApiClient,
  accountAddress: string,
  symbol: string,
  timeoutMs: number
): Promise<Position | null> {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const account = await api.getFullAccount(accountAddress);
    const position = account.positions.find((item) => getPositionSymbol(item) === symbol);

    if (position && Math.abs(position.size) > 0) {
      return position;
    }

    await sleep(2_000);
  }

  return null;
}

async function waitForClosedPosition(
  api: BulkApiClient,
  accountAddress: string,
  symbol: string,
  timeoutMs: number
): Promise<boolean> {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const account = await api.getFullAccount(accountAddress);
    const position = account.positions.find((item) => getPositionSymbol(item) === symbol);
    const stillOpenOrders = account.openOrders.some((item) => item.symbol === symbol);

    if ((!position || Math.abs(position.size) === 0) && !stillOpenOrders) {
      return true;
    }

    await sleep(2_000);
  }

  return false;
}

function computeAggressiveLimitPrice(
  referencePrice: number,
  side: "buy" | "sell",
  offsetBps: number,
  tickSize: number
): number {
  const rawPrice = side === "buy"
    ? referencePrice * (1 + offsetBps / 10_000)
    : referencePrice * (1 - offsetBps / 10_000);

  return roundToNearestStep(rawPrice, tickSize);
}

function roundToNearestStep(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) {
    return value;
  }

  const rounded = Math.round(value / step) * step;
  const precision = countDecimals(step);
  return Number(rounded.toFixed(precision));
}

function parseDailySymbols(raw: string, exchangeInfo: ExchangeSymbolInfo[]): string[] {
  const supported = new Set(exchangeInfo.map((item) => item.symbol));
  const symbols = raw
    .split(",")
    .map((item) => normalizeSymbol(item))
    .filter(Boolean);

  if (symbols.length === 0) {
    fail("symbols must contain at least one market symbol.");
  }

  for (const symbol of symbols) {
    if (!supported.has(symbol)) {
      fail(`Unknown daily-cycle symbol: ${symbol}`);
    }
  }

  return Array.from(new Set(symbols));
}

function selectBatchDailyCycleProfiles(
  profiles: WalletProfile[],
  options: BatchDailyCycleCommandOptions
): Array<{ profile: WalletProfile; originalIndex: number }> {
  const requestedNames = options.wallets
    ? new Set(
        options.wallets
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      )
    : undefined;

  let selected = profiles
    .map((profile, originalIndex) => ({ profile, originalIndex }))
    .filter((entry) => !requestedNames || requestedNames.has(entry.profile.name));

  if (requestedNames && selected.length !== requestedNames.size) {
    const foundNames = new Set(selected.map((entry) => entry.profile.name));
    const missing = Array.from(requestedNames).filter((name) => !foundNames.has(name));
    fail(`Unknown wallet names in --wallets: ${missing.join(", ")}`);
  }

  if (options.shuffleWallets) {
    selected = shuffleArray(selected);
  }

  if (options.maxWallets) {
    const maxWallets = parsePositiveIntegerOption(options.maxWallets, "max-wallets");
    selected = selected.slice(0, maxWallets);
  }

  if (selected.length === 0) {
    fail("No wallets selected for batch-daily-cycle.");
  }

  return selected;
}

function parsePositiveIntegerOption(raw: string, label: string): number {
  const value = Number(raw);

  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    fail(`${label} must be a positive integer.`);
  }

  return value;
}

function parsePercentageOption(raw: string, label: string): number {
  const value = Number(raw);

  if (!Number.isFinite(value) || value < 0 || value > 100) {
    fail(`${label} must be between 0 and 100.`);
  }

  return value;
}

function normalizePercentSizingInput(raw: string): string {
  const trimmed = raw.trim();

  if (!trimmed) {
    fail("size-range cannot be empty.");
  }

  const percent = resolvePercentInput(trimmed);

  if (percent === null) {
    fail("size-range must be a percent like 20% or a range like 12-28%.");
  }

  return trimmed.includes("-")
    ? trimmed.replace(/\s+/g, "")
    : `${percent}%`;
}

function drawPercentSizingInput(raw: string): string {
  if (!raw.includes("-")) {
    return raw;
  }

  const match = raw.match(/^(\d+(?:\.\d+)?)%?\s*-\s*(\d+(?:\.\d+)?)%$/);

  if (!match) {
    return raw;
  }

  return `${randomPercentInRange(Number(match[1]), Number(match[2]))}%`;
}

function shuffleArray<T>(items: T[]): T[] {
  const result = [...items];

  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }

  return result;
}

function markAccountActiveDay(
  accountState: {
    lastActiveDate?: string;
    activeDaysStreak: number;
  },
  localDate: string
): void {
  if (accountState.lastActiveDate === localDate) {
    return;
  }

  if (accountState.lastActiveDate && getPreviousDateString(localDate) === accountState.lastActiveDate) {
    accountState.activeDaysStreak += 1;
  } else {
    accountState.activeDaysStreak = 1;
  }

  accountState.lastActiveDate = localDate;
}

function getLocalDateString(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    fail(`Failed to resolve local date for timezone ${timeZone}.`);
  }

  return `${year}-${month}-${day}`;
}

function getPreviousDateString(dateText: string): string {
  const match = dateText.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!match) {
    fail(`Invalid local date string: ${dateText}`);
  }

  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  date.setUTCDate(date.getUTCDate() - 1);

  return date.toISOString().slice(0, 10);
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
