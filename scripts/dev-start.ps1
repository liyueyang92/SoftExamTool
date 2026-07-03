# dev-start.ps1
# One-shot dev launcher: Python service + Electron hot-reload.
# Usage (from repo root):  .\scripts\dev-start.ps1
# Usage (via npm):         cd electron-app && npm run dev:all
#
# Press Ctrl-C to stop both processes.

$ErrorActionPreference = 'Stop'

# Set UTF-8 code page so Node.js/Electron Chinese log output isn't garbled.
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

$Root   = Split-Path -Parent $PSScriptRoot
$SvcDir = Join-Path $Root 'python-service'
$PyExe  = Join-Path $SvcDir '.venv\Scripts\python.exe'
$AppDir = Join-Path $Root 'electron-app'

# ── Validate venv ────────────────────────────────────────────────────────────
if (-not (Test-Path $PyExe)) {
    Write-Error "[dev] Python venv not found at $PyExe`nRun: python -m venv python-service/.venv && python-service/.venv/Scripts/pip install -r python-service/requirements.txt"
}

# ── Dev environment — fixed values so Electron main can hard-code them in dev ─
# These match the defaults in python-service/.env.example and electron-app dev config.
$env:INTERNAL_PORT  = '8765'
$env:INTERNAL_TOKEN = 'dev-token-local'

# ── Kill any process already holding the port ────────────────────────────────
$oldPid = (netstat -ano 2>$null |
    Select-String "127\.0\.0\.1:$env:INTERNAL_PORT\s.*LISTENING" |
    ForEach-Object { ($_ -split '\s+')[-1] } |
    Select-Object -First 1)
if ($oldPid) {
    Write-Host "[dev] Port $env:INTERNAL_PORT in use by PID $oldPid - terminating..." -ForegroundColor Yellow
    Stop-Process -Id ([int]$oldPid) -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}

Write-Host "[dev] Starting Python service on port $env:INTERNAL_PORT ..." -ForegroundColor Cyan

# -Environment is PS 7.3+ only; set vars in parent so the child inherits them.
$PyProc = Start-Process `
    -FilePath $PyExe `
    -ArgumentList 'main.py' `
    -WorkingDirectory $SvcDir `
    -PassThru -NoNewWindow

Write-Host "[dev] Python PID $($PyProc.Id)  Waiting 2s for startup..." -ForegroundColor DarkGray
Start-Sleep -Seconds 2

try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$env:INTERNAL_PORT/health" -TimeoutSec 3 -UseBasicParsing
    if ($r.StatusCode -eq 200) {
        Write-Host "[dev] Python service ready." -ForegroundColor Green
    }
} catch {
    Write-Warning "[dev] Python /health did not respond — check output above."
}

Write-Host "[dev] Starting Electron dev server  (Ctrl-C stops both)..." -ForegroundColor Cyan

try {
    Push-Location $AppDir
    npx electron-vite dev
} finally {
    Pop-Location
    if ($PyProc -and -not $PyProc.HasExited) {
        Write-Host "`n[dev] Stopping Python (PID $($PyProc.Id))..." -ForegroundColor DarkGray
        Stop-Process -Id $PyProc.Id -Force -ErrorAction SilentlyContinue
    }
    Write-Host "[dev] Done." -ForegroundColor Green
}
