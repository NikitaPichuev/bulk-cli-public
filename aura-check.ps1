$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

node .\dist\cli.js batch-aura `
  --file .wallets.json `
  --proxies-file .proxies.txt `
  --concurrency 3 `
  --browser `
  --delay-ms 1000 `
  --jitter-ms 2000 `
  --output .aura-points.json

$code = $LASTEXITCODE
if ($code -ne 0) {
  Write-Host ""
  Write-Host "ERROR: node exited with code $code"
  Write-Host ""
  Read-Host "Press Enter to close"
  exit $code
}

Write-Host ""
Write-Host "AURA check finished. Report: .aura-points.json"
Read-Host "Press Enter to close"
