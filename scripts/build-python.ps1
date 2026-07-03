# build-python.ps1
# Packages the FastAPI backend into a self-contained folder via PyInstaller.
# Output: electron-app/resources/python-service/
# Run from the repository root:  .\scripts\build-python.ps1
#
# Optional env vars:
#   PYINSTALLER_EXTRA_ARGS  - additional flags forwarded to pyinstaller
#   SKIP_CLEAN              - set to '1' to keep the previous build/dist folders

param(
    [switch]$SkipClean
)

$ErrorActionPreference = 'Stop'
$Root       = Split-Path -Parent $PSScriptRoot
$SvcDir     = Join-Path $Root 'python-service'
$PyExe      = Join-Path $SvcDir '.venv\Scripts\python.exe'
$PyInstaller = Join-Path $SvcDir '.venv\Scripts\pyinstaller.exe'
$SpecFile   = Join-Path $SvcDir 'python-service.spec'
$DestDir    = Join-Path $Root 'electron-app\resources\python-service'

# ── Prerequisites ────────────────────────────────────────────────────────────
if (-not (Test-Path $PyExe)) {
    Write-Error "[build-python] venv not found at $PyExe`nRun: python -m venv python-service/.venv && python-service/.venv/Scripts/pip install -r python-service/requirements.txt"
}
if (-not (Test-Path $PyInstaller)) {
    Write-Error "[build-python] PyInstaller not found. Run: $PyExe -m pip install pyinstaller"
}

# ── Clean previous outputs ───────────────────────────────────────────────────
if (-not $SkipClean) {
    foreach ($d in @('dist', 'build-pyinstaller')) {
        $p = Join-Path $SvcDir $d
        if (Test-Path $p) {
            Write-Host "[build-python] Removing $p" -ForegroundColor DarkGray
            Remove-Item -Recurse -Force $p
        }
    }
}

# ── PyInstaller build ────────────────────────────────────────────────────────
if ($env:SKIP_PLAYWRIGHT_INSTALL -ne '1') {
    Write-Host "[build-python] Ensuring Playwright Chromium is installed..." -ForegroundColor Cyan
    $_savedBrowsersPath = $env:PLAYWRIGHT_BROWSERS_PATH
    $env:PLAYWRIGHT_BROWSERS_PATH = '0'
    & $PyExe -m playwright install chromium
    $env:PLAYWRIGHT_BROWSERS_PATH = $_savedBrowsersPath
    if ($LASTEXITCODE -ne 0) {
        throw "playwright install chromium exited with code $LASTEXITCODE"
    }
} else {
    Write-Warning "[build-python] SKIP_PLAYWRIGHT_INSTALL=1, Chromium runtime will not be verified."
}

Write-Host "[build-python] Running PyInstaller..." -ForegroundColor Cyan
Push-Location $SvcDir
try {
    $_savedBrowsersPathForBuild = $env:PLAYWRIGHT_BROWSERS_PATH
    $env:PLAYWRIGHT_BROWSERS_PATH = '0'
    $extra = $env:PYINSTALLER_EXTRA_ARGS -split ' ' | Where-Object { $_ }
    & $PyInstaller $SpecFile `
        --distpath dist `
        --workpath build-pyinstaller `
        --noconfirm `
        @extra
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller exited with code $LASTEXITCODE" }
} finally {
    $env:PLAYWRIGHT_BROWSERS_PATH = $_savedBrowsersPathForBuild
    Pop-Location
}

# ── Copy output to Electron resources ───────────────────────────────────────
$BuiltDir = Join-Path $SvcDir 'dist\python-service'
if (-not (Test-Path $BuiltDir)) {
    throw "[build-python] Expected output not found: $BuiltDir"
}

Write-Host "[build-python] Copying to $DestDir" -ForegroundColor Cyan
if (Test-Path $DestDir) { Remove-Item -Recurse -Force $DestDir }
Copy-Item -Recurse -Force $BuiltDir $DestDir

# ── Startup-time smoke test ──────────────────────────────────────────────────
$Exe = Join-Path $DestDir 'python-service.exe'
if (-not (Test-Path $Exe)) {
    throw "[build-python] Executable not found after copy: $Exe"
}

Write-Host "[build-python] Smoke-testing executable (5s)..." -ForegroundColor Cyan
# -Environment is PowerShell 7.3+; set vars in parent and let the child inherit them.
$_savedPort  = $env:INTERNAL_PORT
$_savedToken = $env:INTERNAL_TOKEN
$env:INTERNAL_PORT  = '9099'
$env:INTERNAL_TOKEN = 'smoke-test'
$proc = Start-Process -FilePath $Exe `
    -PassThru -NoNewWindow -RedirectStandardOutput "$env:TEMP\pysvc-smoke.log" `
    -RedirectStandardError  "$env:TEMP\pysvc-smoke-err.log"
$env:INTERNAL_PORT  = $_savedPort
$env:INTERNAL_TOKEN = $_savedToken

Start-Sleep -Seconds 5

$healthy = $false
try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:9099/health' -TimeoutSec 2 -UseBasicParsing
    $healthy = ($r.StatusCode -eq 200)
} catch { }

if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }

if ($healthy) {
    Write-Host "[build-python] Smoke test PASSED" -ForegroundColor Green
} else {
    $log = (Get-Content "$env:TEMP\pysvc-smoke-err.log" -ErrorAction SilentlyContinue) -join "`n"
    Write-Warning "[build-python] Smoke test FAILED (service did not respond on /health)"
    if ($log) { Write-Warning $log }
}

# ── Size report ──────────────────────────────────────────────────────────────
$sizeMB = [math]::Round((Get-ChildItem $DestDir -Recurse | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Host "[build-python] Done. Output: $DestDir ($sizeMB MB)" -ForegroundColor Green
