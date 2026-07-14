# build-all.ps1
# Full release build pipeline: Python service -> Electron installer.
# Run from the repository root:  .\scripts\build-all.ps1
#
# Flags are forwarded to the individual scripts:
#   -Target  nsis|portable|dir   (forwarded to build-electron.ps1, default: nsis)
#   -SkipPython                  skip PyInstaller step (use existing resources/)
#   -SkipTypecheck               skip tsc / vue-tsc
#   -SkipE2E                     skip Playwright E2E test suite

param(
    [ValidateSet('nsis','portable','dir')]
    [string]$Target = 'nsis',
    [switch]$SkipPython,
    [switch]$SkipTypecheck,
    [switch]$SkipE2E
)

$ErrorActionPreference = 'Stop'
$ScriptsDir = $PSScriptRoot
$Root       = Split-Path -Parent $ScriptsDir
$StartTime  = Get-Date

function Step([string]$name, [scriptblock]$block) {
    Write-Host "`n==============================" -ForegroundColor DarkGray
    Write-Host " $name" -ForegroundColor White
    Write-Host "==============================" -ForegroundColor DarkGray
    $t = Get-Date
    & $block
    $elapsed = [math]::Round(((Get-Date) - $t).TotalSeconds, 1)
    Write-Host "[$name] Completed in $($elapsed)s" -ForegroundColor DarkGreen
}

# ── Environment summary ──────────────────────────────────────────────────────
Write-Host "[build-all] Starting full build pipeline" -ForegroundColor Cyan
Write-Host "  Root:   $Root"
Write-Host "  Target: $Target"
Write-Host "  E2E:    $(if ($SkipE2E) { 'skip' } else { 'enabled' })"
node --version 2>&1 | Write-Host
python --version 2>&1 | Write-Host

# ── Step 1: Python service ───────────────────────────────────────────────────
if (-not $SkipPython) {
    Step 'Build Python service' {
        & (Join-Path $ScriptsDir 'build-python.ps1')
    }
} else {
    Write-Host "[build-all] Skipping Python build (-SkipPython)" -ForegroundColor Yellow
}

# ── Step 2: JS bundles (vite build only) ─────────────────────────────────────
# Run before E2E tests so they can use the compiled bundles.
# Also needed for the subsequent electron-builder packaging.
$AppDir = Join-Path $Root 'electron-app'
Step 'Build JS bundles' {
    Push-Location $AppDir
    try {
        npx electron-vite build
        if ($LASTEXITCODE -ne 0) { throw "electron-vite build failed" }
    } finally {
        Pop-Location
    }
}

# ── Step 3: E2E tests (in clean env before native rebuild + packaging) ───────
if (-not $SkipE2E) {
    Step 'E2E tests' {
        Push-Location $AppDir
        try {
            npm run test:e2e
            if ($LASTEXITCODE -ne 0) {
                throw "E2E tests failed (exit code $LASTEXITCODE). Release aborted."
            }
        } finally {
            Pop-Location
        }
    }
} else {
    Write-Host "[build-all] Skipping E2E tests (-SkipE2E)" -ForegroundColor Yellow
}

# ── Step 4: Electron packaging (native rebuild + electron-builder) ────────────
# Uses the bundles already built in Step 2 (skips typecheck and vite build).
Step 'Package Electron app' {
    & (Join-Path $ScriptsDir 'build-electron.ps1') -Target $Target -SkipTypecheck:$SkipTypecheck -SkipViteBuild
}

# ── Summary ──────────────────────────────────────────────────────────────────
$total = [math]::Round(((Get-Date) - $StartTime).TotalSeconds, 0)
$releaseDir = Join-Path $Root 'release'
Write-Host "`n=============================="                    -ForegroundColor Green
Write-Host " Build complete in $($total)s"                      -ForegroundColor Green
Write-Host " Release -> $releaseDir"                            -ForegroundColor Green
Write-Host "=============================="                      -ForegroundColor Green
