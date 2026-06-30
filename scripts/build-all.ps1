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

# ── Step 2: Electron app ─────────────────────────────────────────────────────
Step 'Build Electron app' {
    $args = @("-Target $Target")
    if ($SkipTypecheck) { $args += '-SkipTypecheck' }
    & (Join-Path $ScriptsDir 'build-electron.ps1') -Target $Target -SkipTypecheck:$SkipTypecheck
}

# ── Step 3: E2E tests ────────────────────────────────────────────────────────
if (-not $SkipE2E) {
    Step 'E2E tests' {
        $appDir = Join-Path $Root 'electron-app'

        # Verify the compiled main entry exists before running tests
        $mainEntry = Join-Path $appDir 'out\main\index.js'
        if (-not (Test-Path $mainEntry)) {
            throw "Compiled main entry not found at $mainEntry. Run build first."
        }

        Push-Location $appDir
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

# ── Summary ──────────────────────────────────────────────────────────────────
$total = [math]::Round(((Get-Date) - $StartTime).TotalSeconds, 0)
$releaseDir = Join-Path $Root 'release'
Write-Host "`n=============================="                    -ForegroundColor Green
Write-Host " Build complete in $($total)s"                      -ForegroundColor Green
Write-Host " Release -> $releaseDir"                            -ForegroundColor Green
Write-Host "=============================="                      -ForegroundColor Green
