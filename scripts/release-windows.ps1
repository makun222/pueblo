param(
  [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir

Push-Location $projectRoot

try {
  if (-not $SkipBuild.IsPresent) {
    Write-Host '==> Building desktop application bundles'
    npm run build
    if ($LASTEXITCODE -ne 0) {
      throw "npm run build failed with exit code $LASTEXITCODE"
    }

    Write-Host '==> Rebuilding native Electron dependencies'
    npm run rebuild:electron-native
    if ($LASTEXITCODE -ne 0) {
      throw "npm run rebuild:electron-native failed with exit code $LASTEXITCODE"
    }
  }

  $releaseDir = Join-Path $projectRoot 'release'
  $appDir = Join-Path $releaseDir 'Pueblo-win32-x64'
  $electronDistDir = Join-Path $projectRoot 'node_modules\electron\dist'
  $runtimeAppDir = Join-Path $appDir 'resources\app'

  if (-not (Test-Path $electronDistDir)) {
    throw "Electron runtime was not found at $electronDistDir"
  }

  if (Test-Path $appDir) {
    Remove-Item -Path $appDir -Recurse -Force
  }

  New-Item -ItemType Directory -Path $appDir -Force | Out-Null

  Write-Host '==> Copying Electron runtime'
  Copy-Item -Path (Join-Path $electronDistDir '*') -Destination $appDir -Recurse -Force

  $electronExePath = Join-Path $appDir 'electron.exe'
  $puebloExePath = Join-Path $appDir 'Pueblo.exe'
  if (-not (Test-Path $electronExePath)) {
    throw "Electron executable was not found at $electronExePath"
  }

  if (Test-Path $puebloExePath) {
    Remove-Item -Path $puebloExePath -Force
  }

  Rename-Item -Path $electronExePath -NewName 'Pueblo.exe'

  Write-Host '==> Creating packaged app payload'
  New-Item -ItemType Directory -Path $runtimeAppDir -Force | Out-Null
  Copy-Item -Path (Join-Path $projectRoot 'dist') -Destination (Join-Path $runtimeAppDir 'dist') -Recurse -Force
  Copy-Item -Path (Join-Path $projectRoot 'package.json') -Destination (Join-Path $runtimeAppDir 'package.json') -Force

  $packageLockPath = Join-Path $projectRoot 'package-lock.json'
  if (Test-Path $packageLockPath) {
    Copy-Item -Path $packageLockPath -Destination (Join-Path $runtimeAppDir 'package-lock.json') -Force
  }

  Copy-Item -Path (Join-Path $projectRoot 'node_modules') -Destination (Join-Path $runtimeAppDir 'node_modules') -Recurse -Force

  Write-Host '==> Pruning devDependencies from packaged app payload'
  Push-Location $runtimeAppDir
  try {
    npm prune --omit=dev
    if ($LASTEXITCODE -ne 0) {
      throw "npm prune --omit=dev failed with exit code $LASTEXITCODE"
    }
  }
  finally {
    Pop-Location
  }

  Copy-Item -Path (Join-Path $projectRoot 'package.json') -Destination (Join-Path $appDir 'package.json') -Force

  $profileDir = Join-Path $projectRoot 'puebl-profile'
  if (Test-Path $profileDir) {
    Copy-Item -Path $profileDir -Destination (Join-Path $appDir 'puebl-profile') -Recurse -Force
    Copy-Item -Path $profileDir -Destination (Join-Path $runtimeAppDir 'puebl-profile') -Recurse -Force
  }

  if (-not (Test-Path $puebloExePath)) {
    throw "Windows executable was not created: $puebloExePath"
  }

  Write-Host "==> Windows executable created: $puebloExePath"
}
finally {
  Pop-Location
}