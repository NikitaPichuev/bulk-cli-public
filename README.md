# Bulk CLI

CLI for Bulk testnet trading from `C:\script\bulk-public`.

## Кратко

Текущий рабочий сценарий:

- `faucet.ps1` - массовый faucet по кошелькам из `.wallets.json`
- `start-big-cycle.ps1` - массовый trading cycle по кошелькам из `.wallets.json`

Текущий runtime:

- Node.js entrypoint: `node dist\cli.js`
- package version: `0.1.0`
- signer package: `bulk-keychain ^0.1.12`
- default API: `https://exchange-api.bulk.trade/api/v1`

## Установка

```powershell
cd C:\script\bulk-public
npm install
npm run build
```

Показать список CLI-команд:

```powershell
cd C:\script\bulk-public
node dist\cli.js --help
```

## Файлы

- `.wallets.json` - список кошельков для batch-режима
- `.proxies.txt` - список прокси, по одному на строку
- `.activity-state.json` - локальный state для faucet/activity
- `.env` - публичные настройки
- `.secrets.env` - приватные ключи для single-wallet режима
- `start-big-cycle.ps1` - готовый запуск большого круга
- `faucet.ps1` - готовый запуск faucet

## Формат прокси

Поддерживаются:

```text
host:port
host:port@login:password
http://login:password@host:port
```

Если прокси в `.proxies.txt` меньше, чем кошельков в `.wallets.json`, список прокси переиспользуется по кругу.

## Основной запуск

### 1. Faucet

Рекомендуемый запуск:

```powershell
cd C:\script\bulk-public
powershell -NoProfile -ExecutionPolicy Bypass -File .\faucet.ps1
```

Что делает `faucet.ps1`:

```powershell
node dist\cli.js batch-faucet `
  --file .wallets.json `
  --proxies-file .proxies.txt `
  --delay-ms 15000 `
  --jitter-ms 15000
```

### 2. Большой круг

Рекомендуемый запуск:

```powershell
cd C:\script\bulk-public
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-big-cycle.ps1
```

Текущие параметры `start-big-cycle.ps1`:

```powershell
node dist\cli.js batch-daily-cycle `
  --file .wallets.json `
  --proxies-file .proxies.txt `
  --concurrency 3 `
  --symbols "BTC" `
  --min-trades 4 `
  --max-trades 8 `
  --size-range 20-42% `
  --leverage 20-30 `
  --min-hold-minutes 5 `
  --max-hold-minutes 30 `
  --min-wait-minutes 15 `
  --max-wait-minutes 90 `
  --limit-probability 0
```

## Ручной запуск без `.ps1`

### Faucet

```powershell
cd C:\script\bulk-public
node dist\cli.js batch-faucet --file .wallets.json --proxies-file .proxies.txt --delay-ms 15000 --jitter-ms 15000
```

### Большой круг

```powershell
cd C:\script\bulk-public
node dist\cli.js batch-daily-cycle --file .wallets.json --proxies-file .proxies.txt --concurrency 3 --symbols BTC --min-trades 4 --max-trades 8 --size-range 20-42% --leverage 20-30 --min-hold-minutes 5 --max-hold-minutes 30 --min-wait-minutes 15 --max-wait-minutes 90 --limit-probability 0
```

## Полезные команды

Показать внешний IP:

```powershell
cd C:\script\bulk-public
node dist\cli.js ip
```

Dry-run faucet:

```powershell
cd C:\script\bulk-public
node dist\cli.js batch-faucet --file .wallets.json --proxies-file .proxies.txt --delay-ms 15000 --jitter-ms 15000 --dry-run
```

Dry-run большого круга на одном кошельке:

```powershell
cd C:\script\bulk-public
node dist\cli.js batch-daily-cycle --file .wallets.json --proxies-file .proxies.txt --max-wallets 1 --symbols BTC --min-trades 4 --max-trades 8 --size-range 20-42% --leverage 20-30 --min-hold-minutes 5 --max-hold-minutes 30 --min-wait-minutes 15 --max-wait-minutes 90 --limit-probability 0 --dry-run
```

## Single-wallet команды

Они существуют в CLI, но не являются основным batch-сценарием:

```powershell
node dist\cli.js connect --help
node dist\cli.js faucet --help
node dist\cli.js positions --help
node dist\cli.js buy --help
node dist\cli.js sell --help
node dist\cli.js close --help
node dist\cli.js daily-cycle --help
```

## Ошибки

### `Invalid URL`

Обычно это битый формат прокси в `.proxies.txt`.

Корректные варианты:

```text
host:port
host:port@login:password
http://login:password@host:port
```

### `HTTP 404`

Если появляется снова, это уже не старый баг reference price. Значит нужно смотреть конкретный endpoint в текущем коде.

### `HTTP 408` / `HTTP 502`

Это обычно API Bulk или прокси.

Что делать:

- уменьшить `--concurrency`
- проверить прокси
- повторить запуск позже

### `bad signature`

Это проблема подписи запроса или несовместимости signer flow.

### `unauthorized signer`

Это значит, что сервер не принимает текущего signer для конкретного действия.

### Окно PowerShell сразу закрывается

`faucet.ps1` и `start-big-cycle.ps1` уже завернуты в `try/catch` и ждут `Enter` перед закрытием окна.

Если скрипт упал, текст ошибки останется на экране.

## Git

В git не должны попадать:

- `.env`
- `.secrets.env`
- `.wallets.json`
- `.proxies.txt`
- `.activity-state.json`
- `.wallets.failed.json`
- `node_modules`
- `dist`
