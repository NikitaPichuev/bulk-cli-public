$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

node .\dist\cli.js predeposit-leaderboard `
  --page 1 `
  --page-size 10000 `
  --print-rows 100 `
  --output .predeposit-leaderboard.json `
  --csv .predeposit-leaderboard.csv `
  --post .predeposit-post.txt

$code = $LASTEXITCODE
if ($code -ne 0) {
  Write-Host ""
  Write-Host "ERROR: node exited with code $code"
  Write-Host ""
  Read-Host "Press Enter to close"
  exit $code
}

Write-Host ""
Read-Host "Press Enter to close"
