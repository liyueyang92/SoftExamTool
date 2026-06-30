# 一键启动开发环境（在仓库根目录执行：.\scripts\dev-start.ps1）
# Electron 会自行 spawn Python，此脚本仅用于需要独立观察两侧日志时手动启动 Python
$ErrorActionPreference = 'Stop'
$RootDir = Split-Path -Parent $PSScriptRoot

$PythonExe = Join-Path $RootDir 'python-service\.venv\Scripts\python.exe'
$PythonMain = Join-Path $RootDir 'python-service\main.py'

if (-not (Test-Path $PythonExe)) {
    Write-Host "[Error] Python venv not found. Run: python -m venv python-service/.venv && python-service/.venv/Scripts/pip install -r python-service/requirements.txt" -ForegroundColor Red
    exit 1
}

Write-Host "[Dev] Starting Python service..." -ForegroundColor Cyan
$pythonProc = Start-Process -FilePath $PythonExe `
    -ArgumentList $PythonMain `
    -Environment @{ INTERNAL_PORT = '8765'; INTERNAL_TOKEN = 'dev-token'; LOG_LEVEL = 'DEBUG' } `
    -PassThru -NoNewWindow

Write-Host "[Dev] Python PID: $($pythonProc.Id)" -ForegroundColor Cyan

Set-Location (Join-Path $RootDir 'electron-app')
try {
    npm run dev
} finally {
    if (-not $pythonProc.HasExited) {
        Stop-Process -Id $pythonProc.Id -Force
        Write-Host "[Dev] Python service stopped." -ForegroundColor Yellow
    }
    Set-Location $RootDir
}
