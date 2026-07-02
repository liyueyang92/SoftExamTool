import asyncio
import random
from urllib.parse import urljoin

import httpx
from loguru import logger

from modules.crawler.adapters.base import CrawlerAdapterBase
from modules.crawler.errors import CrawlerFetchError, CrawlerParseError
from modules.crawler.schemas import CrawlRuleModel, RawItem, RuntimeContext
from modules.crawler.utils.selectors import attr_from, list_from, text_from
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
                    item_selector,
                    fields,
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
        item_selector: str,
        fields: dict,
        detail_link_selector: str | None,
    ) -> list[RawItem]:
        headers = {'User-Agent': random_user_agent()}
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
                content = text_from(item, fields.get('content') or rule.question_field)
                if not content:
                    continue
                options = list_from(item, fields.get('options') or rule.options_field)
                detail_href = attr_from(item, detail_link_selector, 'href') if detail_link_selector else ''
                source_url = urljoin(url, detail_href) if detail_href else url
                results.append(RawItem(
                    title=text_from(item, fields.get('title')),
                    content=content,
                    options=options or None,
                    answer=text_from(item, fields.get('answer') or rule.answer_field) or None,
                    explanation=text_from(item, fields.get('explanation') or rule.expl_field) or None,
                    source_url=source_url,
                    source_site=rule.site_name,
                    raw={'adapter': 'http_rule'},
                ))
            return results
        except Exception as exc:
            raise CrawlerParseError(f'Parse failed: {exc}') from exc
