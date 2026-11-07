# Build the Folia 0.7.26 lyric embed into vendor/folia.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$embed = Join-Path $root 'folia-embed'
$nodeHome = Join-Path $root '.tools\node-v24.22.1-win-x64'
if (Test-Path (Join-Path $nodeHome 'node.exe')) {
  $env:PATH = "$nodeHome;" + $env:PATH
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'node is not on PATH and .tools\node-v24.22.1-win-x64 was not found'
}
if (-not (Test-Path (Join-Path $embed 'node_modules\vite\bin\vite.js'))) {
  Write-Host 'Installing folia-embed dependencies'
  Push-Location $embed
  npm install --no-audit --no-fund
  Pop-Location
}
Write-Host "Building Folia embed from $embed"
Push-Location $embed
node .\node_modules\vite\bin\vite.js build
if ($LASTEXITCODE -ne 0) { Pop-Location; exit $LASTEXITCODE }
node .\publish.mjs
Pop-Location
Write-Host "Output: $(Join-Path $root 'vendor\folia')"
Get-ChildItem (Join-Path $root 'vendor\folia') | Select-Object Name, Length
