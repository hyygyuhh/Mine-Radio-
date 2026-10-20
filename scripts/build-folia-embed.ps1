# Build Folia full-screen lyric embed into vendor/folia for Mine-Radio static hosting.
$ErrorActionPreference = 'Stop'
$folia = Join-Path (Split-Path $PSScriptRoot -Parent) '..\folia-major-main' | Resolve-Path
$folia = (Resolve-Path (Join-Path (Split-Path $PSScriptRoot -Parent) '..\folia-major-main')).Path
if (-not (Test-Path (Join-Path $folia 'package.json'))) {
  $folia = 'd:\Users\z1590\Desktop\folia-major-main'
}
Write-Host "Building Folia embed from $folia"
Set-Location $folia
$env:FOLIA_BUILD_REPO = 'chthollyphile/folia-major'
node .\node_modules\vite\bin\vite.js build --config vite.mineradio-embed.config.ts
$out = Join-Path (Split-Path $PSScriptRoot -Parent) 'vendor\folia'
Write-Host "Output: $out"
Get-ChildItem $out | Select-Object Name, Length
