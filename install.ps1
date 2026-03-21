$ErrorActionPreference = "Stop"

Set-Location -LiteralPath $PSScriptRoot

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm not found. Install Node.js first."
}

npm install
npm run build

if (-not (Test-Path -LiteralPath ".env")) {
  @(
    "BULK_API_BASE_URL=https://exchange-api.bulk.trade/api/v1",
    "BULK_PROXY_URL=",
    "BULK_ACCOUNT_ADDRESS=",
    "BULK_AGENT_PUBLIC_KEY="
  ) | Set-Content ".env"
}

if (-not (Test-Path -LiteralPath ".secrets.env")) {
  @(
    "# Paste one owner private key on the first line",
    "# or use BULK_OWNER_SECRET_KEY=..."
  ) | Set-Content ".secrets.env"
}

if (-not (Test-Path -LiteralPath ".wallets.json")) {
  Set-Content ".wallets.json" "[]"
}

if (-not (Test-Path -LiteralPath ".seeds.txt")) {
  New-Item -ItemType File ".seeds.txt" | Out-Null
}

if (-not (Test-Path -LiteralPath ".proxies.txt")) {
  New-Item -ItemType File ".proxies.txt" | Out-Null
}

Write-Host ""
Write-Host "Install complete."
Write-Host "Templates prepared: .env, .secrets.env, .wallets.json, .seeds.txt, .proxies.txt"
Write-Host "Next step for single wallet: .\run.ps1 connect --save-owner-secret"
Write-Host "Next step for batch: fill .wallets.json, then run .\run.ps1 batch-connect --file .wallets.json"
