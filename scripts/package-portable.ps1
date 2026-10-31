param([switch]$PrivateBuild)

$ErrorActionPreference = 'Stop'

$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$packageJson = Get-Content -Raw -Encoding UTF8 (Join-Path $workspace 'package.json') |
  ConvertFrom-Json
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $workspace 'release'))
$edition = if ($PrivateBuild) { 'private-portable' } else { 'portable' }
if (-not $PrivateBuild) {
  & node (Join-Path $workspace 'scripts\check-public-boundary.cjs') --build
  if ($LASTEXITCODE -ne 0) { throw 'Refusing to package a private build as a community release.' }
}
$targetBase = Join-Path $releaseRoot "EnglishPracticeAssistant-$edition-v$($packageJson.version)"
$target = [IO.Path]::GetFullPath($targetBase)

if (Test-Path -LiteralPath $target) {
  $target = [IO.Path]::GetFullPath(
    "$targetBase-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  )
}

if (-not $target.StartsWith(
  $releaseRoot + [IO.Path]::DirectorySeparatorChar,
  [StringComparison]::OrdinalIgnoreCase
)) {
  throw "Refusing to package outside release directory: $target"
}

$electronDist = Join-Path $workspace 'node_modules\electron\dist'
$rendererOutput = Join-Path $workspace 'out'
$sherpaNode = Join-Path $workspace 'node_modules\sherpa-onnx-node'
$sherpaWindows = Join-Path $workspace 'node_modules\sherpa-onnx-win-x64'
$betterSqlite = Join-Path $workspace 'node_modules\better-sqlite3'
$bindings = Join-Path $workspace 'node_modules\bindings'
$fileUriToPath = Join-Path $workspace 'node_modules\file-uri-to-path'
$sevenZip = Join-Path $workspace 'node_modules\7zip-bin\win\x64\7za.exe'
$sevenZipLicense = Join-Path $workspace 'node_modules\7zip-bin\LICENSE.txt'
$unrarLicense = Join-Path $workspace 'node_modules\node-unrar-js\LICENSE.md'

foreach ($requiredPath in @($electronDist, $rendererOutput, $sherpaNode, $sherpaWindows, $betterSqlite, $bindings, $fileUriToPath, $sevenZip, $sevenZipLicense, $unrarLicense)) {
  if (-not (Test-Path -LiteralPath $requiredPath)) {
    throw "Required packaging input is missing: $requiredPath"
  }
}

New-Item -ItemType Directory -Path $target -Force | Out-Null
Copy-Item -Path (Join-Path $electronDist '*') -Destination $target -Recurse -Force
Rename-Item -LiteralPath (Join-Path $target 'electron.exe') `
  -NewName 'EnglishPracticeAssistant.exe'

$appDir = Join-Path $target 'resources\app'
New-Item -ItemType Directory -Path $appDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $appDir 'out') -Force | Out-Null
foreach ($productionPart in @('main', 'preload', 'renderer')) {
  Copy-Item -LiteralPath (Join-Path $rendererOutput $productionPart) `
    -Destination (Join-Path $appDir "out\$productionPart") -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $workspace 'package.json') `
  -Destination (Join-Path $appDir 'package.json') -Force

$appModules = Join-Path $appDir 'node_modules'
New-Item -ItemType Directory -Path $appModules -Force | Out-Null
Copy-Item -LiteralPath $sherpaNode `
  -Destination (Join-Path $appModules 'sherpa-onnx-node') -Recurse -Force
Copy-Item -LiteralPath $sherpaWindows `
  -Destination (Join-Path $appModules 'sherpa-onnx-win-x64') -Recurse -Force
Copy-Item -LiteralPath $betterSqlite `
  -Destination (Join-Path $appModules 'better-sqlite3') -Recurse -Force
Copy-Item -LiteralPath $bindings `
  -Destination (Join-Path $appModules 'bindings') -Recurse -Force
Copy-Item -LiteralPath $fileUriToPath `
  -Destination (Join-Path $appModules 'file-uri-to-path') -Recurse -Force

# Copy every production dependency (including hoisted pure-JS transitive
# dependencies used by subtitle parsing) while preserving its node_modules
# relative path. Native modules copied above are skipped when already present.
$nodeModulesRoot = [IO.Path]::GetFullPath((Join-Path $workspace 'node_modules'))
$productionModules = & npm.cmd ls --omit=dev --parseable --all 2>$null |
  Where-Object {
    $_ -and
    $_ -ne $workspace -and
    $_.StartsWith(
      $nodeModulesRoot + [IO.Path]::DirectorySeparatorChar,
      [StringComparison]::OrdinalIgnoreCase
    )
  } |
  Sort-Object Length

foreach ($modulePath in $productionModules) {
  $absoluteModulePath = [IO.Path]::GetFullPath($modulePath)
  $relativeModulePath = $absoluteModulePath.Substring(
    $nodeModulesRoot.Length
  ).TrimStart(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
  )
  $destination = Join-Path $appModules $relativeModulePath
  if (Test-Path -LiteralPath $destination) {
    continue
  }
  New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force |
    Out-Null
  Copy-Item -LiteralPath $modulePath -Destination $destination -Recurse -Force
}

$subtitleToolsDir = Join-Path $target 'resources\subtitle-tools'
New-Item -ItemType Directory -Path $subtitleToolsDir -Force | Out-Null
Copy-Item -LiteralPath $sevenZip `
  -Destination (Join-Path $subtitleToolsDir '7za.exe') -Force
Copy-Item -LiteralPath $sevenZipLicense `
  -Destination (Join-Path $subtitleToolsDir '7zip-bin-LICENSE.txt') -Force
Copy-Item -LiteralPath $unrarLicense `
  -Destination (Join-Path $subtitleToolsDir 'node-unrar-js-LICENSE.md') -Force

$subtitleDataDir = Join-Path $target 'data\subtitles'
New-Item -ItemType Directory -Path $subtitleDataDir -Force | Out-Null

$zipPath = "$target.zip"
tar.exe -a -c -f $zipPath -C $releaseRoot (Split-Path $target -Leaf)
if ($LASTEXITCODE -ne 0) {
  throw "Failed to create portable ZIP: $zipPath"
}

$hash = Get-FileHash $zipPath -Algorithm SHA256
Write-Output "Portable directory: $target"
Write-Output "Portable ZIP: $zipPath"
Write-Output "SHA256: $($hash.Hash)"
