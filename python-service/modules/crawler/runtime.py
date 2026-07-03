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
            browser = await p.chromium.launch(headless=True)
            await browser.close()
        return CrawlerRuntimeStatus(
            playwright_available=True,
            chromium_ready=True,
            message='Chromium is ready',
        )
    except Exception as exc:
        return CrawlerRuntimeStatus(
            playwright_available=True,
            chromium_ready=False,
            message=f'Chromium is not ready. Run: playwright install chromium. Detail: {exc}',
        )
