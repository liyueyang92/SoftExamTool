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
$Requirements = Join-Path $SvcDir 'requirements.txt'
$DestDir    = Join-Path $Root 'electron-app\resources\python-service'

function Stop-ProcessTree {
    param([int]$ProcessId)

    $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $ProcessId" -ErrorAction SilentlyContinue
    foreach ($child in $children) {
        Stop-ProcessTree -ProcessId $child.ProcessId
    }
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

function Install-PlaywrightChromiumFromNpmmirror {
    $browsersJson = Join-Path $SvcDir '.venv\Lib\site-packages\playwright\driver\package\browsers.json'
    if (-not (Test-Path $browsersJson)) {
        Write-Warning "[build-python] Playwright browsers.json not found, cannot use npmmirror fallback."
        return $false
    }

    $descriptor = (Get-Content -Raw $browsersJson | ConvertFrom-Json).browsers |
        Where-Object { $_.name -eq 'chromium' } |
        Select-Object -First 1
    if (-not $descriptor) {
        Write-Warning "[build-python] Chromium descriptor not found, cannot use npmmirror fallback."
        return $false
    }

    $directHost = $env:PLAYWRIGHT_CHROMIUM_DIRECT_DOWNLOAD_HOST
    if (-not $directHost) {
        $directHost = 'https://cdn.npmmirror.com/binaries/chrome-for-testing'
    }

    $browserDir = Join-Path $SvcDir ".venv\Lib\site-packages\playwright\driver\package\.local-browsers\chromium-$($descriptor.revision)"
    $browserExe = Join-Path $browserDir 'chrome-win64\chrome.exe'
    $markerFile = Join-Path $browserDir 'INSTALLATION_COMPLETE'
    if ((Test-Path $browserExe) -and (Test-Path $markerFile)) {
        Write-Host "[build-python] Playwright Chromium already installed at $browserExe" -ForegroundColor DarkGray
        return $true
    }

    $downloadUrl = "$directHost/$($descriptor.browserVersion)/win64/chrome-win64.zip"
    $zipPath = Join-Path $env:TEMP "playwright-chromium-$($descriptor.revision).zip"
    Write-Host "[build-python] Downloading Chromium from $downloadUrl" -ForegroundColor Cyan
    Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
    Invoke-WebRequest -Uri $downloadUrl -OutFile $zipPath -UseBasicParsing

    Remove-Item -Recurse -Force $browserDir -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force $browserDir | Out-Null
    Expand-Archive -Path $zipPath -DestinationPath $browserDir -Force
    if (-not (Test-Path $browserExe)) {
        throw "[build-python] npmmirror Chromium fallback did not produce expected executable: $browserExe"
    }
    New-Item -ItemType File -Force $markerFile | Out-Null
    Write-Host "[build-python] Playwright Chromium installed from npmmirror fallback." -ForegroundColor Green
    return $true
}

# ── Prerequisites ────────────────────────────────────────────────────────────
if (-not (Test-Path $PyExe)) {
    Write-Error "[build-python] venv not found at $PyExe`nRun: python -m venv python-service/.venv && python-service/.venv/Scripts/pip install -r python-service/requirements.txt"
}
if (-not (Test-Path $Requirements)) {
    Write-Error "[build-python] requirements.txt not found at $Requirements"
}

Write-Host "[build-python] Ensuring Python dependencies are installed..." -ForegroundColor Cyan
& $PyExe -m pip install -r $Requirements
if ($LASTEXITCODE -ne 0) {
    throw "pip install -r requirements.txt exited with code $LASTEXITCODE"
}
if (-not (Test-Path $PyInstaller)) {
    Write-Error "[build-python] PyInstaller not found after installing requirements. Run: $PyExe -m pip install -r $Requirements"
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
    $playwrightInstallTimeoutSec = 600
    if ($env:PLAYWRIGHT_INSTALL_TIMEOUT_SEC) {
        $playwrightInstallTimeoutSec = [int]$env:PLAYWRIGHT_INSTALL_TIMEOUT_SEC
    }
    $playwrightInstallOut = Join-Path $env:TEMP 'playwright-install-chromium.log'
    $playwrightInstallErr = Join-Path $env:TEMP 'playwright-install-chromium-err.log'
    Remove-Item $playwrightInstallOut, $playwrightInstallErr -Force -ErrorAction SilentlyContinue
    $_savedBrowsersPath = $env:PLAYWRIGHT_BROWSERS_PATH
    try {
        $env:PLAYWRIGHT_BROWSERS_PATH = '0'
        $playwrightInstall = Start-Process -FilePath $PyExe `
            -ArgumentList @('-m', 'playwright', 'install', 'chromium') `
            -WorkingDirectory $SvcDir `
            -PassThru -NoNewWindow `
            -RedirectStandardOutput $playwrightInstallOut `
            -RedirectStandardError $playwrightInstallErr
        if (-not $playwrightInstall.WaitForExit($playwrightInstallTimeoutSec * 1000)) {
            Stop-ProcessTree -ProcessId $playwrightInstall.Id
            Write-Warning "[build-python] playwright install chromium timed out after ${playwrightInstallTimeoutSec}s, trying npmmirror fallback."
            if (-not (Install-PlaywrightChromiumFromNpmmirror)) {
                throw "playwright install chromium timed out after ${playwrightInstallTimeoutSec}s. Check network access to Playwright browser downloads, set PLAYWRIGHT_DOWNLOAD_HOST to a valid mirror, or set SKIP_PLAYWRIGHT_INSTALL=1 to skip bundling Chromium."
            }
        }
        $playwrightStdout = (Get-Content $playwrightInstallOut -ErrorAction SilentlyContinue) -join "`n"
        $playwrightStderr = (Get-Content $playwrightInstallErr -ErrorAction SilentlyContinue) -join "`n"
        if ($playwrightStdout) { Write-Host $playwrightStdout }
        if ($playwrightStderr) { Write-Warning $playwrightStderr }
        if ($playwrightInstall.ExitCode -ne 0) {
            Write-Warning "[build-python] playwright install chromium exited with code $($playwrightInstall.ExitCode), trying npmmirror fallback."
            if (-not (Install-PlaywrightChromiumFromNpmmirror)) {
                throw "playwright install chromium exited with code $($playwrightInstall.ExitCode). Set PLAYWRIGHT_DOWNLOAD_HOST to a valid mirror or SKIP_PLAYWRIGHT_INSTALL=1 to skip bundling Chromium."
            }
        }
    } finally {
        $env:PLAYWRIGHT_BROWSERS_PATH = $_savedBrowsersPath
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
