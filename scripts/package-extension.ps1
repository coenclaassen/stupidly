$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$extensionDir = Join-Path $root "extension"
$manifestPath = Join-Path $extensionDir "manifest.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$version = $manifest.version

if (-not $version) {
  throw "manifest.json does not contain a version."
}

$distDir = Join-Path $root "dist"
$stageDir = Join-Path $distDir "package"
$zipPath = Join-Path $distDir "sitelimit-$version.zip"

$packageItems = @(
  "manifest.json",
  "service-worker.js",
  "settings.html",
  "settings.css",
  "settings.js",
  "blocked.html",
  "blocked.css",
  "blocked.js",
  "icons/icon16.png",
  "icons/icon32.png",
  "icons/icon48.png",
  "icons/icon128.png"
)

New-Item -ItemType Directory -Force -Path $distDir | Out-Null

if (Test-Path -LiteralPath $stageDir) {
  Remove-Item -LiteralPath $stageDir -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $stageDir | Out-Null

foreach ($item in $packageItems) {
  $source = Join-Path $extensionDir $item
  if (-not (Test-Path -LiteralPath $source)) {
    throw "Missing package item: $item"
  }

  $destination = Join-Path $stageDir $item
  $destinationParent = Split-Path -Parent $destination
  New-Item -ItemType Directory -Force -Path $destinationParent | Out-Null
  Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
}

if (Test-Path -LiteralPath $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}

Compress-Archive -Path (Join-Path $stageDir "*") -DestinationPath $zipPath -Force
Remove-Item -LiteralPath $stageDir -Recurse -Force

Write-Host "Created $zipPath"
