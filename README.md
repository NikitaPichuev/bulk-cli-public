# Bulk CLI

TypeScript CLI for Bulk testnet perpetual trading via direct API.

The project supports:

- direct signed trading without browser clicking
- owner wallet + agent wallet flow
- testnet faucet / Claim USDC during `connect`
- single wallet and batch wallet modes
- percent sizing like `50%`
- random percent ranges like `40-50%`
- per-process proxy from `.env`
- per-wallet proxies from `.proxies.txt`
- seed phrase to private key conversion

## What It Does

Main commands:

- `connect`
- `faucet`
- `buy`
- `sell`
- `close`
- `positions`
- `batch-connect`
- `batch-buy`
- `batch-sell`
- `batch-close`
- `ip`

## Requirements

- Windows PowerShell
- Node.js 22+ recommended

## Install

```powershell
npm install
.\install.ps1
npm run build
```

`install.ps1` creates missing local working files:

- `.env`
- `.secrets.env`
- `.wallets.json`
- `.seeds.txt`
- `.proxies.txt`

## Config Files

Public config:

- `.env`

Secrets:

- `.secrets.env`
- `.wallets.json`
- `.seeds.txt`

Batch proxies:

- `.proxies.txt`

These files are ignored by git through [`.gitignore`](/C:/Users/Admin/OneDrive/Документы/bulk-public/.gitignore).

## Single Wallet Quick Start

1. Open [`.secrets.env`](/C:/Users/Admin/OneDrive/Документы/bulk-public/.secrets.env)
2. Paste one owner private key on the first line
3. Run:

```powershell
.\run.ps1 connect --save-owner-secret
```

Then:

```powershell
.\run.ps1 positions
.\run.ps1 buy BTC 40-50% --leverage 10
.\run.ps1 close BTC
```

## Batch Quick Start

1. Open [`.wallets.json`](/C:/Users/Admin/OneDrive/Документы/bulk-public/.wallets.json)
2. Paste private keys as a JSON array:

```json
[
  "PRIVATE_KEY_1",
  "PRIVATE_KEY_2",
  "PRIVATE_KEY_3"
]
```

3. Optional: open [`.proxies.txt`](/C:/Users/Admin/OneDrive/Документы/bulk-public/.proxies.txt) and paste one proxy per line

Examples:

```text
1.2.3.4:8080
login:password@1.2.3.5:8080
```

The bot automatically prepends `http://` when needed.

4. Connect wallets:

```powershell
node dist\cli.js batch-connect --file .wallets.json --proxies-file .proxies.txt --delay-ms 5000 --jitter-ms 5000
```

5. Open BTC longs with random percent sizing:

```powershell
node dist\cli.js batch-buy BTC 40-50% --file .wallets.json --proxies-file .proxies.txt --leverage 10 --delay-ms 5000 --jitter-ms 5000
```

6. Close BTC positions:

```powershell
node dist\cli.js batch-close BTC --file .wallets.json --proxies-file .proxies.txt --delay-ms 5000 --jitter-ms 5000
```

## Seed Phrases

If you only have seed phrases:

1. Open [`.seeds.txt`](/C:/Users/Admin/OneDrive/Документы/bulk-public/.seeds.txt)
2. Put one seed phrase per line
3. Run:

```powershell
.\derive-seeds.ps1
```

This updates [`.wallets.json`](/C:/Users/Admin/OneDrive/Документы/bulk-public/.wallets.json).

## Test Funds / Claim USDC

`connect` and `batch-connect` request test funds and verify that mock USDC appeared on the account.

Result objects include:

- `faucetRequested`
- `faucetStatus`
- `balanceVerified`
- `totalBalance`
- `availableBalance`

Typical successful result:

```json
{
  "faucetRequested": true,
  "faucetStatus": "claimed",
  "balanceVerified": true,
  "totalBalance": 10000,
  "availableBalance": 10000
}
```

## Proxies

Global proxy for the whole process goes into [`.env`](/C:/Users/Admin/OneDrive/Документы/bulk-public/.env):

```env
BULK_PROXY_URL=host:port
```

or

```env
BULK_PROXY_URL=login:password@host:port
```

Batch proxies go into [`.proxies.txt`](/C:/Users/Admin/OneDrive/Документы/bulk-public/.proxies.txt), one per line.

If proxies are fewer than wallets, the list is reused in a loop from the top.

## Useful Commands

Show current external IP:

```powershell
node dist\cli.js ip
```

Build and connect in one line:

```powershell
npm run build; if ($?) { node dist\cli.js batch-connect --file .wallets.json --proxies-file .proxies.txt }
```

## Notes

- Target API: `https://exchange-api.bulk.trade/api/v1`
- This project is for Bulk testnet flow
- `connect` sets max leverage for all available markets by default
- Default batch delay is now `5-10` seconds between wallets
- Batch connect retries temporary errors like `408`, `429`, and `5xx`

## Safety

Do not publish:

- [`.secrets.env`](/C:/Users/Admin/OneDrive/Документы/bulk-public/.secrets.env)
- [`.wallets.json`](/C:/Users/Admin/OneDrive/Документы/bulk-public/.wallets.json)
- [`.seeds.txt`](/C:/Users/Admin/OneDrive/Документы/bulk-public/.seeds.txt)
- [`.proxies.txt`](/C:/Users/Admin/OneDrive/Документы/bulk-public/.proxies.txt)

Before pushing to GitHub, check `git status` and make sure only public files are staged.
