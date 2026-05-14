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
    --symbols "BTC,ETH" `
    --min-trades 4 `
    --max-trades 8 `
    --size-range 20-42% `
    --leverage 20-30 `
    --min-hold-minutes 5 `
    --max-hold-minutes 30 `
    --min-wait-minutes 15 `
    --max-wait-minutes 90 `
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
