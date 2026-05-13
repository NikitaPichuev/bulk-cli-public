# Bulk CLI

CLI for Bulk testnet trading from `C:\script\bulk-public`.

Current local build:

- package version: `0.1.0`
- signer package: `bulk-keychain ^0.1.11`
- default API: `https://exchange-api.bulk.trade/api/v1`
- main entrypoint: `node dist\cli.js`

## Install And Build

Run once after download or update:

```powershell
cd C:\script\bulk-public
npm install
npm run build
```

Check CLI help:

```powershell
cd C:\script\bulk-public
node dist\cli.js --help
```

## Files

- `.env` - public config, including `BULK_API_BASE_URL` and optional `BULK_PROXY_URL`.
- `.secrets.env` - private keys for single-wallet mode.
- `.wallets.json` - batch wallet list.
- `.proxies.txt` - one proxy per line for batch mode.
- `.activity-state.json` - local daily-cycle state.
- `.wallets.failed.json` - failed wallets backup/list if created by previous runs.

Proxy formats accepted:

```text
host:port
host:port@login:password
http://login:password@host:port
```

If `.proxies.txt` has fewer lines than `.wallets.json`, proxies are reused from the top.

## Quick Health Checks

Show current CLI commands:

```powershell
cd C:\script\bulk-public
node dist\cli.js --help
```

Show visible external IP:

```powershell
cd C:\script\bulk-public
node dist\cli.js ip
```

Dry-run one wallet daily-cycle:

```powershell
cd C:\script\bulk-public
node dist\cli.js batch-daily-cycle --file .wallets.json --proxies-file .proxies.txt --max-wallets 1 --dry-run
```

Dry-run faucet schedule:

```powershell
cd C:\script\bulk-public
node dist\cli.js batch-faucet --file .wallets.json --proxies-file .proxies.txt --delay-ms 15000 --jitter-ms 15000 --dry-run
```

## Single Wallet Setup

Use this mode only when `.secrets.env` contains one owner private key.

Connect one wallet, register agent wallet, claim faucet, and set max leverage:

```powershell
cd C:\script\bulk-public
node dist\cli.js connect --save-owner-secret
```

Connect without faucet:

```powershell
cd C:\script\bulk-public
node dist\cli.js connect --save-owner-secret --skip-faucet
```

Connect without max leverage setup:

```powershell
cd C:\script\bulk-public
node dist\cli.js connect --save-owner-secret --skip-max-leverage
```

Claim faucet for configured account:

```powershell
cd C:\script\bulk-public
node dist\cli.js faucet
```

Claim faucet signed by owner key:

```powershell
cd C:\script\bulk-public
node dist\cli.js faucet --owner
```

## Single Wallet Trading

Show positions and margin:

```powershell
cd C:\script\bulk-public
node dist\cli.js positions
```

Show raw JSON:

```powershell
cd C:\script\bulk-public
node dist\cli.js positions --json
```

Open long market order:

```powershell
cd C:\script\bulk-public
node dist\cli.js buy BTC 35% --leverage 7
```

Open short market order:

```powershell
cd C:\script\bulk-public
node dist\cli.js sell ETH 30% --leverage 6
```

Use random percent range:

```powershell
cd C:\script\bulk-public
node dist\cli.js buy BTC 30-40% --leverage 5-10
```

Use limit order:

```powershell
cd C:\script\bulk-public
node dist\cli.js buy BTC 35% --price 65000 --tif GTC --leverage 7
```

Close one symbol:

```powershell
cd C:\script\bulk-public
node dist\cli.js close BTC
```

Symbols can be short or full:

```text
BTC
ETH
SOL
BTC-USD
ETH-USD
SOL-USD
```

## Batch Faucet

Claim faucet for all wallets from `.wallets.json`, one proxy per wallet from `.proxies.txt`.
This does not register agent wallets.

```powershell
cd C:\script\bulk-public
node dist\cli.js batch-faucet --file .wallets.json --proxies-file .proxies.txt --delay-ms 15000 --jitter-ms 15000
```

## Batch Connect

Connect all wallets from `.wallets.json`, one proxy per wallet from `.proxies.txt`:

```powershell
cd C:\script\bulk-public
node dist\cli.js batch-connect --file .wallets.json --proxies-file .proxies.txt --delay-ms 15000 --jitter-ms 15000
```

Without faucet:

```powershell
cd C:\script\bulk-public
node dist\cli.js batch-connect --file .wallets.json --proxies-file .proxies.txt --delay-ms 15000 --jitter-ms 15000 --skip-faucet
```

Without max leverage setup:

```powershell
cd C:\script\bulk-public
node dist\cli.js batch-connect --file .wallets.json --proxies-file .proxies.txt --delay-ms 15000 --jitter-ms 15000 --skip-max-leverage
```

Dry-run only:

```powershell
cd C:\script\bulk-public
node dist\cli.js batch-connect --file .wallets.json --proxies-file .proxies.txt --delay-ms 15000 --jitter-ms 15000 --dry-run
```

## Batch Daily Cycle

Default behavior:

- wallets: from `.wallets.json`
- proxies: from `.proxies.txt`
- concurrency: `3`
- symbols: `BTC,ETH`
- trades per wallet: `3-8`
- size per trade: `20-40%`
- leverage: `5-10`
- hold per trade: `5-30` minutes
- wait between trades: `15-90` minutes
- order type: market by default, because `--limit-probability` default is `0`

Big cycle settings:

- symbols: `BTC,ETH,SOL`
- trades per wallet: `3-8`
- size per trade: `20-42%`
- leverage: `10`
- hold per trade: `5-30` minutes
- wait between trades: `15-90` minutes
- limit order probability: `40%`

Recommended big cycle run:

```powershell
cd C:\script\bulk-public
node dist\cli.js batch-daily-cycle --file .wallets.json --proxies-file .proxies.txt --concurrency 3 --symbols BTC,ETH,SOL --min-trades 4 --max-trades 8 --size-range 20-42% --leverage 10 --min-hold-minutes 5 --max-hold-minutes 30 --min-wait-minutes 15 --max-wait-minutes 90 --limit-probability 40
```

Safer big cycle if API is unstable:

```powershell
cd C:\script\bulk-public
node dist\cli.js batch-daily-cycle --file .wallets.json --proxies-file .proxies.txt --concurrency 2 --symbols BTC,ETH,SOL --min-trades 4 --max-trades 8 --size-range 20-42% --leverage 10 --min-hold-minutes 5 --max-hold-minutes 30 --min-wait-minutes 15 --max-wait-minutes 90 --limit-probability 40
```

Dry-run big cycle:

```powershell
cd C:\script\bulk-public
node dist\cli.js batch-daily-cycle --file .wallets.json --proxies-file .proxies.txt --max-wallets 1 --symbols BTC,ETH,SOL --min-trades 4 --max-trades 8 --size-range 20-42% --leverage 10 --min-hold-minutes 5 --max-hold-minutes 30 --min-wait-minutes 15 --max-wait-minutes 90 --limit-probability 40 --dry-run
```

Recommended normal run:

```powershell
cd C:\script\bulk-public
node dist\cli.js batch-daily-cycle --file .wallets.json --proxies-file .proxies.txt --concurrency 3
```

Safer run if API is unstable:

```powershell
cd C:\script\bulk-public
node dist\cli.js batch-daily-cycle --file .wallets.json --proxies-file .proxies.txt --concurrency 2
```

Run only first N wallets:

```powershell
cd C:\script\bulk-public
node dist\cli.js batch-daily-cycle --file .wallets.json --proxies-file .proxies.txt --max-wallets 5 --concurrency 2
```

Run selected wallet names:

```powershell
cd C:\script\bulk-public
node dist\cli.js batch-daily-cycle --file .wallets.json --proxies-file .proxies.txt --wallets wallet-1,wallet-7,wallet-12 --concurrency 2
```

Shuffle and limit wallets:

```powershell
cd C:\script\bulk-public
node dist\cli.js batch-daily-cycle --file .wallets.json --proxies-file .proxies.txt --shuffle-wallets --max-wallets 10 --concurrency 3
```

Dry-run:

```powershell
cd C:\script\bulk-public
node dist\cli.js batch-daily-cycle --file .wallets.json --proxies-file .proxies.txt --max-wallets 2 --dry-run
```

Custom daily-cycle settings:

```powershell
cd C:\script\bulk-public
node dist\cli.js batch-daily-cycle --file .wallets.json --proxies-file .proxies.txt --concurrency 3 --symbols BTC,ETH,SOL --min-trades 4 --max-trades 8 --size-range 20-42% --leverage 10 --min-hold-minutes 5 --max-hold-minutes 30 --min-wait-minutes 15 --max-wait-minutes 90 --limit-probability 40
```

Use limit orders sometimes:

```powershell
cd C:\script\bulk-public
node dist\cli.js batch-daily-cycle --file .wallets.json --proxies-file .proxies.txt --concurrency 2 --limit-probability 20 --limit-offset-bps 8
```

## Single Daily Cycle

Run for the single configured account from `.env` and `.secrets.env`:

```powershell
cd C:\script\bulk-public
node dist\cli.js daily-cycle
```

Dry-run:

```powershell
cd C:\script\bulk-public
node dist\cli.js daily-cycle --dry-run
```

Custom settings:

```powershell
cd C:\script\bulk-public
node dist\cli.js daily-cycle --symbols BTC,ETH --min-trades 3 --max-trades 8 --size-range 20-40% --leverage 5-10 --min-hold-minutes 5 --max-hold-minutes 30 --min-wait-minutes 15 --max-wait-minutes 90
```

## Batch Buy Sell Close

Batch long:

```powershell
cd C:\script\bulk-public
node dist\cli.js batch-buy BTC 35% --file .wallets.json --proxies-file .proxies.txt --delay-ms 5000 --jitter-ms 5000 --leverage 7
```

Batch short:

```powershell
cd C:\script\bulk-public
node dist\cli.js batch-sell ETH 30% --file .wallets.json --proxies-file .proxies.txt --delay-ms 5000 --jitter-ms 5000 --leverage 6
```

Batch close:

```powershell
cd C:\script\bulk-public
node dist\cli.js batch-close BTC --file .wallets.json --proxies-file .proxies.txt --delay-ms 5000 --jitter-ms 5000
```

Batch dry-run:

```powershell
cd C:\script\bulk-public
node dist\cli.js batch-buy BTC 35% --file .wallets.json --proxies-file .proxies.txt --dry-run
```

## Error Notes

`HTTP 502` / `HTTP 408`:

- API or proxy instability.
- Reduce `--concurrency`.
- Retry after platform maintenance.

`bad signature`:

- Usually related to Bulk signature verification or signer format.
- Current local dependency is `bulk-keychain ^0.1.11`.
- Rebuild after dependency updates: `npm install` then `npm run build`.

`unauthorized signer`:

- The agent wallet may not be registered or may be stale.
- Run `batch-connect` again after the API is stable.
- If it appears only on faucet during `daily-cycle`, the current code logs a warning and continues trading.
- Do not run `batch-connect` repeatedly while agent wallet registration returns `bad signature`.

`cancel all ... no orders found`:

- Treated as non-fatal in the current code.
- It means there were no open orders to cancel for that symbol.

## Most Used Commands

```powershell
cd C:\script\bulk-public
npm install
npm run build
node dist\cli.js batch-faucet --file .wallets.json --proxies-file .proxies.txt --delay-ms 15000 --jitter-ms 15000
node dist\cli.js batch-daily-cycle --file .wallets.json --proxies-file .proxies.txt --concurrency 3 --symbols BTC,ETH,SOL --min-trades 4 --max-trades 8 --size-range 20-42% --leverage 10 --min-hold-minutes 5 --max-hold-minutes 30 --min-wait-minutes 15 --max-wait-minutes 90 --limit-probability 40
```

If API is unstable:

```powershell
cd C:\script\bulk-public
node dist\cli.js batch-daily-cycle --file .wallets.json --proxies-file .proxies.txt --concurrency 2 --symbols BTC,ETH,SOL --min-trades 4 --max-trades 8 --size-range 20-42% --leverage 10 --min-hold-minutes 5 --max-hold-minutes 30 --min-wait-minutes 15 --max-wait-minutes 90 --limit-probability 40
```

## Launch Files

Only two launch files:

- `faucet.ps1` - faucet only, without agent wallet registration.
- `start-big-cycle.ps1` - big cycle.

```powershell
cd C:\script\bulk-public
powershell -NoProfile -ExecutionPolicy Bypass -File .\faucet.ps1
```

```powershell
cd C:\script\bulk-public
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-big-cycle.ps1
```
