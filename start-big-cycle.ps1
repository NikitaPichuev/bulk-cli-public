$ErrorActionPreference = "Stop"

try {
  Set-Location -LiteralPath $PSScriptRoot

  if (-not (Test-Path -LiteralPath "dist\cli.js")) {
    npm run build
    if ($LASTEXITCODE -ne 0) {
      throw "npm run build failed with exit code $LASTEXITCODE"
    }
  }

  node dist\cli.js batch-daily-cycle `
    --file .wallets.json `
    --proxies-file .proxies.txt `
    --concurrency 3 `
    --symbols "BTC-USD,ETH-USD,ZEC-USD,SOL-USD,SUI-USD,BNB-USD,XRP-USD,FART-USD,DOGE-USD" `
    --min-trades 9 `
    --max-trades 9 `
    --size-range 95-99% `
    --leverage 50 `
    --open-only `
    --min-hold-minutes 1000 `
    --max-hold-minutes 10000 `
    --min-wait-minutes 1 `
    --max-wait-minutes 1 `
    --limit-probability 0

  if ($LASTEXITCODE -ne 0) {
    throw "node exited with code $LASTEXITCODE"
  }
}
catch {
  Write-Host ""
  Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
}
finally {
  Write-Host ""
  Read-Host "Press Enter to close"
}
