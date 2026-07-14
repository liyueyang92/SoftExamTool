# build-electron.ps1
# Builds and packages the Electron app for Windows (NSIS installer + portable).
# Run from the repository root:  .\scripts\build-electron.ps1
#
# Optional env vars (code signing — leave unset for unsigned dev builds):
#   CERT_FILE      - path to .pfx certificate file
#   CERT_PASSWORD  - certificate password
#
# Optional flags:
#   -Target  nsis|portable|dir   default: nsis
#   -SkipTypecheck               skip tsc / vue-tsc

param(
    [ValidateSet('nsis','portable','dir')]
    [string]$Target = 'nsis',
    [switch]$SkipTypecheck,
    [switch]$SkipViteBuild
)

$ErrorActionPreference = 'Stop'
$Root      = Split-Path -Parent $PSScriptRoot
$AppDir    = Join-Path $Root 'electron-app'
$ResDir    = Join-Path $AppDir 'resources\python-service'

# ── Prerequisites ────────────────────────────────────────────────────────────
if (-not (Test-Path (Join-Path $AppDir 'node_modules'))) {
    Write-Error "[build-electron] node_modules not found. Run: cd electron-app && npm install"
}
if (-not (Test-Path $ResDir)) {
    Write-Warning "[build-electron] Python service not bundled yet ($ResDir missing)."
    Write-Warning "                 Run .\scripts\build-python.ps1 first, or set SKIP_PYTHON=1."
    if ($env:SKIP_PYTHON -ne '1') {
        throw "Aborting. Pass -env:SKIP_PYTHON=1 or run build-python.ps1 first."
    }
}

# ── Pre-populate electron zip cache ─────────────────────────────────────────
# electron-builder's @electron/get looks for the zip in a SHA-256-named
# subdirectory of %LOCALAPPDATA%\electron\Cache\.  npm install already
# downloads the zip to the flat root of that directory.  If the hash-dir
# copy is missing, pre-seed it from the flat copy so packaging works
# offline without re-downloading from GitHub.
$ElectronVersion = node -e "console.log(require('./electron-app/node_modules/electron/package.json').version)"
Write-Host "[build-electron] Electron version: $ElectronVersion" -ForegroundColor DarkGray
if ($ElectronVersion) {
    $ZipName   = "electron-v$ElectronVersion-win32-x64.zip"
    $CacheRoot = "$env:LOCALAPPDATA\electron\Cache"

    # Compute the URL-hash directory using the same logic as @electron/get
    $HashDir = node -e "
const crypto = require('crypto');
const url    = 'https://github.com/electron/electron/releases/download/v$ElectronVersion';
console.log(crypto.createHash('sha256').update(url).digest('hex'));
"
    $HashPath = Join-Path $CacheRoot "$HashDir\$ZipName"
    if (-not (Test-Path $HashPath)) {
        # Try to find the zip anywhere in the cache root
        $FlatZip = Get-ChildItem $CacheRoot -Filter $ZipName -Recurse -ErrorAction SilentlyContinue |
                   Select-Object -First 1
        if ($FlatZip) {
            New-Item -ItemType Directory -Force -Path (Split-Path $HashPath) | Out-Null
            Copy-Item $FlatZip.FullName $HashPath
            Write-Host "[build-electron] Seeded electron cache: $HashPath" -ForegroundColor DarkGray
        } else {
            Write-Warning "[build-electron] Electron zip not found in cache — first packaging will download it from GitHub."
            Write-Warning "                 Ensure network access to github.com or run 'npm install' first."
        }
    }
}

Push-Location $AppDir
try {
    # ── Mirror overrides (avoids GitHub timeouts on restricted networks) ──────
    if (-not $env:ELECTRON_MIRROR) {
        $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
    }
    if (-not $env:ELECTRON_BUILDER_BINARIES_MIRROR) {
        $env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
    }

    # ── TypeScript typecheck ─────────────────────────────────────────────────
    if (-not $SkipTypecheck) {
        Write-Host "[build-electron] Type-checking..." -ForegroundColor Cyan
        npm run typecheck
        if ($LASTEXITCODE -ne 0) { throw "Typecheck failed" }
    }

    # ── Vite build (main + preload + renderer) ───────────────────────────────
    if (-not $SkipViteBuild) {
        Write-Host "[build-electron] Building bundles..." -ForegroundColor Cyan
        npx electron-vite build
        if ($LASTEXITCODE -ne 0) { throw "electron-vite build failed" }
    } else {
        Write-Host "[build-electron] Skipping vite build (-SkipViteBuild)" -ForegroundColor Yellow
    }

    # ── Native module rebuild for production target ──────────────────────────
    Write-Host "[build-electron] Rebuilding native modules for Electron..." -ForegroundColor Cyan
    npm run rebuild
    if ($LASTEXITCODE -ne 0) { throw "electron-rebuild failed" }

    # ── electron-builder package ─────────────────────────────────────────────
    Write-Host "[build-electron] Packaging ($Target)..." -ForegroundColor Cyan
    $builderArgs = @('--win', $Target)
    if ($env:CERT_FILE -and $env:CERT_PASSWORD) {
        Write-Host "[build-electron] Code signing enabled." -ForegroundColor DarkGray
        # Credentials are passed via env vars; electron-builder reads them from
        # CSC_LINK and CSC_KEY_PASSWORD automatically.
        $env:CSC_LINK         = $env:CERT_FILE
        $env:CSC_KEY_PASSWORD = $env:CERT_PASSWORD
    } else {
        Write-Warning "[build-electron] No certificate provided — installer will be unsigned."
    }
    npx electron-builder @builderArgs
    if ($LASTEXITCODE -ne 0) { throw "electron-builder failed" }

    # ── Promote artifacts to repo-root release/ ──────────────────────────────
    # electron-builder writes to electron-app/dist/ to avoid cross-directory
    # rename issues on Windows (EPERM from proper-lockfile's fs.watch).
    # After a successful build we move the artifacts one level up.
    $distDir    = Join-Path $AppDir 'dist'
    $releaseDir = Join-Path $Root  'release'
    Write-Host "[build-electron] Promoting artifacts: dist/ -> $releaseDir" -ForegroundColor Cyan

    if (Test-Path $releaseDir) { Remove-Item -Recurse -Force $releaseDir }
    Move-Item -Path $distDir -Destination $releaseDir

    # ── Size report ──────────────────────────────────────────────────────────
    Write-Host "`n[build-electron] Release files:" -ForegroundColor Green
    Get-ChildItem $releaseDir -File -ErrorAction SilentlyContinue | ForEach-Object {
        $mb = [math]::Round($_.Length / 1MB, 1)
        Write-Host "  $($_.Name)  ($mb MB)"
    }
    Write-Host "  -> $releaseDir" -ForegroundColor DarkGray
    Write-Host "[build-electron] Done." -ForegroundColor Green

} finally {
    Pop-Location
}
