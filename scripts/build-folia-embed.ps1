# Build Folia full-screen lyric embed into vendor/folia for Mine-Radio static hosting.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$candidates = @(
  (Join-Path $root '..\folia-major-0.7.22'),
  (Join-Path $root '..\folia-major-main'),
  'd:\Users\z1590\Desktop\folia-major-0.7.22',
  'd:\Users\z1590\Desktop\folia-major-main'
)
$folia = $null
foreach ($c in $candidates) {
  $resolved = $null
  try { $resolved = (Resolve-Path $c -ErrorAction Stop).Path } catch { continue }
  if (Test-Path (Join-Path $resolved 'package.json')) {
    if (Test-Path (Join-Path $resolved 'vite.mineradio-embed.config.ts')) {
      $folia = $resolved
      break
    }
  }
}
if (-not $folia) { throw 'Folia source tree not found (expected folia-major-0.7.22 with vite.mineradio-embed.config.ts)' }
Write-Host "Building Folia embed from $folia"
Set-Location $folia
$env:FOLIA_BUILD_REPO = 'chthollyphile/folia-major'
node .\node_modules\vite\bin\vite.js build --config vite.mineradio-embed.config.ts
$out = Join-Path $root 'vendor\folia'
Write-Host "Output: $out"
Get-ChildItem $out | Select-Object Name, Length
