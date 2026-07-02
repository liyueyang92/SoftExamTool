import asyncio
import random

from modules.crawler.adapters.base import CrawlerAdapterBase
from modules.crawler.auth.session_state import to_playwright_storage_state
from modules.crawler.errors import CrawlerFetchError, CrawlerParseError
from modules.crawler.schemas import CrawlRuleModel, RawItem, RuntimeContext
from modules.crawler.utils.extract import extract_raw_item
from modules.crawler.utils.selectors import attr_from
from modules.progress import push_progress

try:
    from bs4 import BeautifulSoup
    from playwright.async_api import TimeoutError as PlaywrightTimeoutError
    from playwright.async_api import async_playwright
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    BeautifulSoup = None
    PlaywrightTimeoutError = Exception
    async_playwright = None
    PLAYWRIGHT_AVAILABLE = False


class BrowserRuleAdapter(CrawlerAdapterBase):
    async def fetch(self, rule: CrawlRuleModel, context: RuntimeContext) -> list[RawItem]:
        if not PLAYWRIGHT_AVAILABLE or async_playwright is None or BeautifulSoup is None:
            raise CrawlerFetchError(
                'Playwright is not installed. Run: pip install playwright && playwright install chromium',
                code='CRAWLER_BROWSER_RUNTIME_MISSING',
                stage='browser',
            )

        cfg = rule.effective_rule_json()
        list_cfg = cfg.get('list', {})
        pagination_cfg = cfg.get('pagination', {})
        browser_cfg = cfg.get('browser', {})
        request_cfg = cfg.get('request', {})
        detail_cfg = cfg.get('detail', {})
        fields = list_cfg.get('fields', {})
        manual_url = context.manual_input.get('url') if context.manual_input else None
        url_template = manual_url or list_cfg.get('url_template') or rule.url_template
        item_selector = list_cfg.get('item_selector') or rule.item_selector
        max_pages = int(pagination_cfg.get('max_pages') or rule.max_pages)
        delay_ms = int(request_cfg.get('delay_ms') or rule.delay_ms)
        wait_until = browser_cfg.get('wait_until') or 'networkidle'
        wait_selector = browser_cfg.get('wait_selector') or item_selector
        timeout_ms = int(browser_cfg.get('timeout_ms') or 30000)
        detail_link_selector = list_cfg.get('detail_link_selector')

        if not url_template or not item_selector:
            raise CrawlerParseError('Missing url_template or item_selector')

        storage_state = to_playwright_storage_state(context.session_state, _origin_from_url(url_template))
        results: list[RawItem] = []

        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            try:
                page_context = await browser.new_context(storage_state=storage_state)
                page = await page_context.new_page()
                for page_num in range(1, max_pages + 1):
                    url = url_template.replace('{page}', str(page_num))
                    if context.task_id:
                        pct = int((page_num - 1) / max_pages * 90)
                        await push_progress(context.task_id, pct, f'Rendering page {page_num}/{max_pages}')

                    try:
                        await page.goto(url, wait_until=wait_until, timeout=timeout_ms)
                        if wait_selector:
                            await page.wait_for_selector(wait_selector, timeout=timeout_ms)
                    except PlaywrightTimeoutError as exc:
                        raise CrawlerFetchError(
                            f'Browser render timeout: {url}',
                            code='CRAWLER_BROWSER_TIMEOUT',
                            stage='browser',
                        ) from exc

                    html = await page.content()
                    page_items = self._parse_html(
                        html,
                        url,
                        rule,
                        item_selector,
                        fields,
                        detail_link_selector,
                    )
                    if detail_link_selector:
                        detail_items = []
                        for item in page_items:
                            if not item.source_url:
                                continue
                            detail_items.append(await self._fetch_detail(page, item.source_url, rule, detail_cfg or {'fields': fields}, timeout_ms))
                        page_items = detail_items
                    if not page_items:
                        break
                    results.extend(page_items)

                    delay = max(0, delay_ms + random.randint(-300, 300))
                    if delay:
                        await asyncio.sleep(delay / 1000)
            finally:
                await browser.close()

        return results

    def _parse_html(
        self,
        html: str,
        url: str,
        rule: CrawlRuleModel,
        item_selector: str,
        fields: dict,
        detail_link_selector: str | None,
    ) -> list[RawItem]:
        try:
            soup = BeautifulSoup(html, 'lxml')
            results: list[RawItem] = []
            for item in soup.select(item_selector):
                raw = extract_raw_item(
                    item,
                    url=url,
                    rule=rule,
                    fields=fields,
                    detail_link_selector=detail_link_selector,
                    adapter='browser_rule',
                )
                if raw:
                    results.append(raw)
            return results
        except Exception as exc:
            raise CrawlerParseError(f'Browser parse failed: {exc}') from exc

    async def _fetch_detail(self, page, url: str, rule: CrawlRuleModel, detail_cfg: dict, timeout_ms: int) -> RawItem:
        try:
            await page.goto(url, wait_until='networkidle', timeout=timeout_ms)
            root_selector = detail_cfg.get('root_selector')
            if root_selector:
                await page.wait_for_selector(root_selector, timeout=timeout_ms)
            html = await page.content()
        except PlaywrightTimeoutError as exc:
            raise CrawlerFetchError(
                f'Browser detail render timeout: {url}',
                code='CRAWLER_BROWSER_TIMEOUT',
                stage='browser',
            ) from exc

        soup = BeautifulSoup(html, 'lxml')
        root = soup.select_one(detail_cfg.get('root_selector')) if detail_cfg.get('root_selector') else soup
        raw = extract_raw_item(
            root,
            url=url,
            rule=rule,
            fields=detail_cfg.get('fields') or {},
            adapter='browser_rule',
        )
        if not raw:
            raise CrawlerParseError(f'Browser detail parse produced empty content: {url}')
        return raw


def _origin_from_url(url: str) -> str | None:
    if not url:
        return None
    import re
    clean = url.replace('{page}', '1')
    match = re.match(r'^(https?://[^/]+)', clean)
    return match.group(1) if match else None
