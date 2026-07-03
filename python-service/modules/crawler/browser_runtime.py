import os
import sys
import traceback
from pathlib import Path
from typing import Any


def _existing_file(path: Path) -> str | None:
    return str(path) if path.is_file() else None


def _chromium_candidates_from_playwright_package() -> list[str]:
    candidates: list[str] = []
    try:
        import playwright

        package_root = Path(playwright.__file__).resolve().parent
        browsers_root = package_root / 'driver' / 'package' / '.local-browsers'
        for pattern in (
            'chromium-*/chrome-win64/chrome.exe',
            'chromium_headless_shell-*/chrome-win64/chrome.exe',
        ):
            candidates.extend(str(path) for path in browsers_root.glob(pattern) if path.is_file())
    except Exception:
        pass
    return candidates


def _system_chromium_candidates() -> list[str]:
    candidates: list[str] = []
    for env_name in ('PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'):
        root = os.environ.get(env_name)
        if not root:
            continue
        root_path = Path(root)
        for rel in (
            'Google/Chrome/Application/chrome.exe',
            'Microsoft/Edge/Application/msedge.exe',
        ):
            found = _existing_file(root_path / rel)
            if found:
                candidates.append(found)
    return candidates


def chromium_executable_candidates() -> list[str]:
    candidates: list[str] = []
    env_path = os.environ.get('CRAWLER_CHROMIUM_EXECUTABLE') or os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH')
    if env_path:
        candidates.append(env_path)

    candidates.extend(_system_chromium_candidates())
    candidates.extend(_chromium_candidates_from_playwright_package())

    for base in (getattr(sys, '_MEIPASS', None), Path(sys.executable).resolve().parent if sys.executable else None):
        if not base:
            continue
        base_path = Path(base)
        browsers_root = base_path / 'playwright' / 'driver' / 'package' / '.local-browsers'
        for pattern in (
            'chromium-*/chrome-win64/chrome.exe',
            'chromium_headless_shell-*/chrome-win64/chrome.exe',
        ):
            candidates.extend(str(path) for path in browsers_root.glob(pattern) if path.is_file())

    seen: set[str] = set()
    unique: list[str] = []
    for item in candidates:
        normalized = str(Path(item))
        key = normalized.lower()
        if key not in seen:
            seen.add(key)
            unique.append(normalized)
    return unique


def describe_exception(exc: BaseException) -> str:
    text = str(exc)
    if text:
        return f'{type(exc).__name__}: {text}'
    return f'{type(exc).__name__}: {exc!r}'


async def launch_chromium(playwright: Any, *, headless: bool = True):
    errors: list[str] = []
    for executable_path in chromium_executable_candidates():
        try:
            return await playwright.chromium.launch(headless=headless, executable_path=executable_path)
        except Exception as exc:
            errors.append(f'{executable_path}: {describe_exception(exc)}')

    try:
        return await playwright.chromium.launch(headless=headless)
    except Exception as exc:
        if errors:
            raise RuntimeError(
                'All Chromium candidates failed. '
                + ' | '.join(errors)
                + f' | default: {describe_exception(exc)}'
                + ' | traceback: '
                + ''.join(traceback.format_exception_only(type(exc), exc)).strip()
            ) from exc
        raise
