# PyInstaller spec — reproducible build for the FastAPI backend service.
# Run from the python-service/ directory:
#   .venv/Scripts/pyinstaller.exe python-service.spec

import sys
from pathlib import Path

ROOT = Path(SPECPATH)          # python-service/
DIST = ROOT / 'dist'
BUILD = ROOT / 'build-pyinstaller'

block_cipher = None

a = Analysis(
    [str(ROOT / 'main.py')],
    pathex=[str(ROOT)],
    binaries=[],
    datas=[
        # Add static assets as they are introduced in later phases.
        # Format: (src_glob, dest_folder_inside_bundle)
        # Example: (str(ROOT / 'modules/ai/scoring_rubrics'), 'modules/ai/scoring_rubrics'),
    ],
    hiddenimports=[
        # uvicorn lazy-imports its I/O loops and protocol implementations.
        'uvicorn.logging',
        'uvicorn.loops',
        'uvicorn.loops.auto',
        'uvicorn.loops.asyncio',
        'uvicorn.protocols',
        'uvicorn.protocols.http',
        'uvicorn.protocols.http.auto',
        'uvicorn.protocols.http.h11_impl',
        'uvicorn.protocols.http.httptools_impl',
        'uvicorn.protocols.websockets',
        'uvicorn.protocols.websockets.auto',
        'uvicorn.protocols.websockets.websockets_impl',
        'uvicorn.protocols.websockets.wsproto_impl',
        'uvicorn.lifespan',
        'uvicorn.lifespan.off',
        'uvicorn.lifespan.on',
        # Application modules
        'middleware.auth',
        'modules.progress',
        # starlette background tasks used by BaseHTTPMiddleware
        'anyio',
        'anyio._backends._asyncio',
        'anyio._backends._trio',
        'sniffio',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'tkinter', 'unittest', 'doctest', 'pydoc',
        'lib2to3',
        'xmlrpc', 'http.server',
        'multiprocessing.popen_spawn_win32',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,        # --onedir: binaries go in the COLLECT step
    name='python-service',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,                    # UPX can trigger AV false positives
    console=False,                # no console window in production
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='python-service',
)
