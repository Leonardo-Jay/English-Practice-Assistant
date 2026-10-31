$ErrorActionPreference = 'Stop'

$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $workspace 'release'))
$installer = [IO.Path]::GetFullPath(
  (Join-Path $releaseRoot 'EnglishPracticeAssistant-Setup-1.0.0.exe')
)
$installRoot = [IO.Path]::GetFullPath((Join-Path $releaseRoot 'nsis-smoke-install'))

if (-not $installRoot.StartsWith(
  $releaseRoot + [IO.Path]::DirectorySeparatorChar,
  [StringComparison]::OrdinalIgnoreCase
)) {
  throw "Refusing to install outside release directory: $installRoot"
}
if (-not (Test-Path -LiteralPath $installer)) {
  throw "NSIS installer is missing: $installer"
}
$appExe = Join-Path $installRoot 'EnglishPracticeAssistant.exe'
$sqliteBinding = Join-Path $installRoot `
  'resources\app.asar.unpacked\node_modules\better-sqlite3\build\Release\better_sqlite3.node'
if (Test-Path -LiteralPath $installRoot) {
  if (
    -not (Test-Path -LiteralPath $appExe) -or
    -not (Test-Path -LiteralPath $sqliteBinding)
  ) {
    throw "Existing smoke target is incomplete; refusing to overwrite it: $installRoot"
  }
  Write-Output "Resuming the existing smoke-test installation: $installRoot"
} else {
  Write-Output "Installing silently to: $installRoot"
  $installProcess = Start-Process `
    -FilePath $installer `
    -ArgumentList @('/S', "/D=$installRoot") `
    -WindowStyle Hidden `
    -Wait `
    -PassThru
  if ($installProcess.ExitCode -ne 0) {
    throw "NSIS installer exited with code $($installProcess.ExitCode)."
  }
}

if (-not (Test-Path -LiteralPath $appExe)) {
  throw "Installed application executable is missing: $appExe"
}
if (-not (Test-Path -LiteralPath $sqliteBinding)) {
  throw "Installed SQLite native binding is missing: $sqliteBinding"
}
$sqliteBindingBytes = (Get-Item -LiteralPath $sqliteBinding).Length

for ($attempt = 1; $attempt -le 2; $attempt += 1) {
  $stdout = Join-Path $workspace "nsis-smoke-$attempt.stdout.log"
  $stderr = Join-Path $workspace "nsis-smoke-$attempt.stderr.log"
  Write-Output "Launching installed application (attempt $attempt/2)..."
  $appProcess = Start-Process `
    -FilePath $appExe `
    -WindowStyle Hidden `
    -PassThru `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr
  Wait-Process -Id $appProcess.Id -Timeout 6 -ErrorAction SilentlyContinue
  if (-not $appProcess.HasExited) {
    Stop-Process -Id $appProcess.Id
  } elseif ($appProcess.ExitCode -ne 0) {
    throw "Installed application exited early with code $($appProcess.ExitCode)."
  }
  $errorText = if (Test-Path -LiteralPath $stderr) {
    $rawError = Get-Content -Raw -LiteralPath $stderr
    if ($null -eq $rawError) { '' } else { $rawError.Trim() }
  } else {
    ''
  }
  if ($errorText) {
    throw "Installed application wrote to stderr: $errorText"
  }
}

$databasePath = Join-Path $env:APPDATA 'new-practice-english\data\learning.db'
if (-not (Test-Path -LiteralPath $databasePath)) {
  throw "The stable user database was not created or reopened: $databasePath"
}

$uninstaller = Get-ChildItem -LiteralPath $installRoot -Filter 'Uninstall*.exe' -File |
  Select-Object -First 1
if (-not $uninstaller) {
  throw "NSIS uninstaller was not created."
}

Write-Output "Uninstalling smoke-test installation..."
$uninstallProcess = Start-Process `
  -FilePath $uninstaller.FullName `
  -ArgumentList '/S' `
  -WindowStyle Hidden `
  -Wait `
  -PassThru
if ($uninstallProcess.ExitCode -ne 0) {
  throw "NSIS uninstaller exited with code $($uninstallProcess.ExitCode)."
}
if (-not (Test-Path -LiteralPath $databasePath)) {
  throw "User database was deleted by uninstall despite deleteAppDataOnUninstall=false."
}

Write-Output "NSIS_SMOKE_OK"
Write-Output "Installer: $installer"
Write-Output "SQLite binding bytes: $sqliteBindingBytes"
Write-Output "Persistent database: $databasePath"
