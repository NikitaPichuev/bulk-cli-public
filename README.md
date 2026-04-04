# Bulk CLI

Minimal TypeScript CLI for Bulk testnet perp trading via direct API and an agent wallet.

Commands:

- `connect`
- `faucet`
- `buy`
- `sell`
- `close`
- `positions`
- `daily-cycle`
- `batch-daily-cycle`

## Config layout

- Public config goes to `.env`
- Private keys go to `.secrets.env`
- Optional process-wide proxy goes to `.env` as `BULK_PROXY_URL=http://host:port`
- You can also omit the scheme and write `host:port` or `login:password@host:port` - the bot will prepend `http://` automatically
- Simplest `.secrets.env` format: paste only one owner private key on the first line, without `KEY=`

## Install

```bash
npm install
npm run build
```

`install.ps1` also creates safe local templates if they are missing:

- `.env`
- `.secrets.env`
- `.wallets.json`
- `.seeds.txt`
- `.proxies.txt`

## Quick start

1. Put your owner private key into `.secrets.env`
2. Run:

```bash
npm run cli -- connect --save-owner-secret
```

3. Then trade:

```bash
npm run cli -- positions
npm run cli -- buy BTC 50%
npm run cli -- sell ETH 99%
npm run cli -- buy SOL 50%
npm run cli -- close BTC
```

Check which external IP the bot currently uses:

```bash
npm run cli -- ip
```

## Sizing modes

- Base size: `npm run cli -- buy BTC-USD 0.01`
- Deposit percent: `npm run cli -- buy BTC 50%`
- Deposit percent range: `npm run cli -- buy BTC 40-50%`

Percent mode:

- works for `BTC`, `ETH`, `SOL`
- supports fixed percent like `50%` and random range like `40-50%`
- uses current `availableBalance`
- uses current symbol leverage
- rounds size down to the exchange lot size
- applies a small safety buffer so market orders are less likely to be rejected by risk checks

## Notes

- This project targets `https://exchange-api.bulk.trade/api/v1`
- `connect` sets max leverage for all available markets by default
- `connect` now requests test funds and verifies that mock USDC appeared on the account
- If you do not want to keep the owner secret locally, do not use `--save-owner-secret`

## Daily cycle

`daily-cycle` runs one long randomized trading routine for the configured account:

- tries faucet once per local day and stores the result in a local state file
- opens `3-8` trades by default
- mixes long and short directions
- mixes `market` and aggressive `limit` orders
- holds positions for `5-30` minutes by default, then closes them
- randomizes the wait between trades
- tracks `active days` locally in `.activity-state.json`

Example:

```bash
node dist/cli.js daily-cycle
```

More explicit example:

```bash
node dist/cli.js daily-cycle --symbols BTC,ETH,SOL --min-trades 3 --max-trades 8 --size-range 12-28% --leverage 2 --min-hold-minutes 5 --max-hold-minutes 30 --min-wait-minutes 15 --max-wait-minutes 90 --limit-probability 40
```

Notes:

- `daily-cycle` is designed for one configured account, not for batch wallets
- activity tracking is local and stored only in the JSON state file
- if a limit order does not lead to a visible position quickly, the bot cancels leftovers and falls back to market

## Batch daily cycle

`batch-daily-cycle` runs the same daily routine for wallets from `.wallets.json`.

Important:

- this mode can run for a very long time if you let it process many wallets with full hold and wait windows
- use wallet filtering or a small limit per run
- proxy assignment follows wallet row numbers from `.proxies.txt`

Examples:

```bash
node dist/cli.js batch-daily-cycle --file .wallets.json --proxies-file .proxies.txt --max-wallets 3 --shuffle-wallets
```

Run only selected wallets:

```bash
node dist/cli.js batch-daily-cycle --file .wallets.json --proxies-file .proxies.txt --wallets wallet-1,wallet-7,wallet-12
```

Dry run:

```bash
node dist/cli.js batch-daily-cycle --file .wallets.json --proxies-file .proxies.txt --max-wallets 2 --dry-run
```

## Batch wallets

For batch mode you can keep a single file `.wallets.json` and paste only private keys:

```json
[
  "PRIVATE_KEY_1",
  "PRIVATE_KEY_2",
  "PRIVATE_KEY_3"
]
```

Then run:

```bash
node dist/cli.js batch-connect --file .wallets.json
node dist/cli.js batch-buy BTC 50% --file .wallets.json --delay-ms 5000 --jitter-ms 5000
```

## Batch proxies

You can also keep a separate `.proxies.txt` file with one proxy per line, matched to wallets by row number:

```text
proxy-1:port
login:password@proxy-2:port

proxy-4:port
```

An empty line means "no proxy for this wallet".
If proxies are fewer than wallets, the list is reused in a loop from the top.
