$ErrorActionPreference = "Stop"

try {
  Set-Location -LiteralPath $PSScriptRoot

  if (-not (Test-Path -LiteralPath "dist\cli.js")) {
    npm run build
    if ($LASTEXITCODE -ne 0) {
      throw "npm run build failed with exit code $LASTEXITCODE"
    }
  }

  node dist\cli.js batch-faucet `
    --file .wallets.json `
    --proxies-file .proxies.txt `
    --delay-ms 15000 `
    --jitter-ms 15000

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
