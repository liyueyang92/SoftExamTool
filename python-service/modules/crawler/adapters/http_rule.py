import asyncio
import random
import httpx
from loguru import logger

from modules.crawler.adapters.base import CrawlerAdapterBase
from modules.crawler.errors import CrawlerFetchError, CrawlerParseError
from modules.crawler.schemas import CrawlRuleModel, RawItem, RuntimeContext
from modules.crawler.utils.extract import extract_raw_item
from modules.crawler.utils.selectors import attr_from
from modules.crawler.utils.ua import random_user_agent
from modules.progress import push_progress

try:
    from bs4 import BeautifulSoup
    BS4_AVAILABLE = True
except ImportError:
    BS4_AVAILABLE = False


def require_bs4() -> None:
    if not BS4_AVAILABLE:
        raise CrawlerParseError('beautifulsoup4/lxml is not installed')


class HttpRuleAdapter(CrawlerAdapterBase):
    async def fetch(self, rule: CrawlRuleModel, context: RuntimeContext) -> list[RawItem]:
        require_bs4()
        cfg = rule.effective_rule_json()
        list_cfg = cfg.get('list', {})
        pagination_cfg = cfg.get('pagination', {})
        request_cfg = cfg.get('request', {})
        detail_cfg = cfg.get('detail', {})
        fields = list_cfg.get('fields', {})
        manual_url = context.manual_input.get('url') if context.manual_input else None
        url_template = manual_url or list_cfg.get('url_template') or rule.url_template
        item_selector = list_cfg.get('item_selector') or rule.item_selector
        max_pages = int(pagination_cfg.get('max_pages') or rule.max_pages)
        delay_ms = int(request_cfg.get('delay_ms') or rule.delay_ms)
        detail_link_selector = list_cfg.get('detail_link_selector')

        if not url_template or not item_selector:
            raise CrawlerParseError('Missing url_template or item_selector')

        all_items: list[RawItem] = []
        async with httpx.AsyncClient(follow_redirects=True) as client:
            for page in range(1, max_pages + 1):
                url = url_template.replace('{page}', str(page))
                if context.task_id:
                    pct = int((page - 1) / max_pages * 90)
                    await push_progress(context.task_id, pct, f'Fetching page {page}/{max_pages}')

                page_items = await self._fetch_page(
                    client,
                    url,
                    rule,
                    context,
                    item_selector,
                    fields,
                    detail_cfg,
                    detail_link_selector,
                )
                if not page_items:
                    break
                all_items.extend(page_items)

                delay = max(0, delay_ms + random.randint(-300, 300))
                if delay:
                    await asyncio.sleep(delay / 1000)

        return all_items

    async def _fetch_page(
        self,
        client: httpx.AsyncClient,
        url: str,
        rule: CrawlRuleModel,
        context: RuntimeContext,
        item_selector: str,
        fields: dict,
        detail_cfg: dict,
        detail_link_selector: str | None,
    ) -> list[RawItem]:
        headers = self._headers(context)
        try:
            resp = await client.get(url, headers=headers, timeout=20.0)
            resp.raise_for_status()
        except Exception as exc:
            logger.warning('Fetch failed {}: {}', url, exc)
            raise CrawlerFetchError(f'Fetch failed: {url}') from exc

        try:
            soup = BeautifulSoup(resp.text, 'lxml')
            results: list[RawItem] = []
            for item in soup.select(item_selector):
                detail_href = attr_from(item, detail_link_selector, 'href') if detail_link_selector else ''
                if detail_href:
                    detail_url = httpx.URL(url).join(detail_href).human_repr()
                    results.append(await self._fetch_detail(client, detail_url, rule, context, detail_cfg or {'fields': fields}))
                    continue
                raw = extract_raw_item(
                    item,
                    url=url,
                    rule=rule,
                    fields=fields,
                    detail_link_selector=detail_link_selector,
                    adapter='http_rule',
                )
                if raw:
                    results.append(raw)
            return results
        except Exception as exc:
            raise CrawlerParseError(f'Parse failed: {exc}') from exc

    async def _fetch_detail(
        self,
        client: httpx.AsyncClient,
        url: str,
        rule: CrawlRuleModel,
        context: RuntimeContext,
        detail_cfg: dict,
    ) -> RawItem:
        headers = self._headers(context)
        try:
            resp = await client.get(url, headers=headers, timeout=20.0)
            resp.raise_for_status()
        except Exception as exc:
            raise CrawlerFetchError(f'Detail fetch failed: {url}') from exc

        soup = BeautifulSoup(resp.text, 'lxml')
        root_selector = detail_cfg.get('root_selector')
        root = soup.select_one(root_selector) if root_selector else soup
        raw = extract_raw_item(
            root,
            url=url,
            rule=rule,
            fields=detail_cfg.get('fields') or {},
            adapter='http_rule',
        )
        if not raw:
            raise CrawlerParseError(f'Detail parse produced empty content: {url}')
        return raw

    def _cookie_header(self, context: RuntimeContext) -> str:
        state = context.session_state or {}
        cookies = state.get('cookies') if isinstance(state, dict) else None
        if not isinstance(cookies, list):
            return ''
        parts: list[str] = []
        for cookie in cookies:
            if not isinstance(cookie, dict):
                continue
            name = cookie.get('name')
            value = cookie.get('value')
            if name and value:
                parts.append(f'{name}={value}')
        return '; '.join(parts)

    def _headers(self, context: RuntimeContext) -> dict[str, str]:
        headers = {'User-Agent': random_user_agent()}
        cookie_header = self._cookie_header(context)
        if cookie_header:
            headers['Cookie'] = cookie_header
        return headers
