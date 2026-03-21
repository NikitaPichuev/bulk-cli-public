param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ArgsList
)

$ErrorActionPreference = "Stop"

Set-Location -LiteralPath $PSScriptRoot

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm not found. Install Node.js first."
}

if (-not (Test-Path -LiteralPath "dist/cli.js")) {
  npm run build
}

$commandName = if ($ArgsList.Length -gt 0) { $ArgsList[0] } else { "" }
$batchCommands = @("batch-connect", "batch-buy", "batch-sell", "batch-close")

if ($batchCommands -contains $commandName -and -not (Test-Path -LiteralPath ".wallets.json")) {
  throw "Missing .wallets.json. Create it and paste wallet private keys into the JSON array."
}

node dist/cli.js @ArgsList
