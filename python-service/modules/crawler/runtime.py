import asyncio

from modules.crawler.browser_runtime import chromium_executable_candidates, describe_exception, launch_chromium
from modules.crawler.schemas import CrawlerRuntimeStatus

try:
    from playwright.async_api import async_playwright
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    async_playwright = None
    PLAYWRIGHT_AVAILABLE = False


async def check_browser_runtime() -> CrawlerRuntimeStatus:
    if not PLAYWRIGHT_AVAILABLE or async_playwright is None:
        return CrawlerRuntimeStatus(
            playwright_available=False,
            chromium_ready=False,
            message='Playwright is not installed. Run: pip install -r requirements.txt',
        )

    try:
        async with async_playwright() as p:
            browser = await launch_chromium(p, headless=True)
            await browser.close()
        candidates = chromium_executable_candidates()
        return CrawlerRuntimeStatus(
            playwright_available=True,
            chromium_ready=True,
            message=f'Chromium is ready: {candidates[0]}' if candidates else 'Chromium is ready',
        )
    except Exception as exc:
        candidates = chromium_executable_candidates()
        loop_name = type(asyncio.get_running_loop()).__name__
        detail = f'{describe_exception(exc)}. Event loop: {loop_name}'
        if candidates:
            detail = f'Candidates: {candidates}. Detail: {detail}'
        return CrawlerRuntimeStatus(
            playwright_available=True,
            chromium_ready=False,
            message=f'Chromium is not ready. Run: playwright install chromium or set CRAWLER_CHROMIUM_EXECUTABLE. Detail: {detail}',
        )
