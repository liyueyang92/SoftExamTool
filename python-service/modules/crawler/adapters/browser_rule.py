import asyncio
import random

from loguru import logger

from modules.crawler.adapters.base import CrawlerAdapterBase
from modules.crawler.auth.session_state import to_playwright_storage_state
from modules.crawler.browser_runtime import launch_chromium
from modules.crawler.errors import CrawlerFetchError, CrawlerParseError
from modules.crawler.schemas import CrawlRuleModel, RawItem, RuntimeContext
from modules.crawler.utils.extract import extract_raw_item
from modules.crawler.utils.selectors import attr_from, relaxed_selector_variants, selector_variants
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


NEXT_CLICK_DEFAULT_MAX_PAGES = 100
LEGACY_NEXT_CLICK_DEFAULT_MAX_PAGES = 60


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
        pagination_type = pagination_cfg.get('type') or 'page_param'
        has_pagination_max_pages = pagination_cfg.get('max_pages') is not None
        if pagination_type == 'next_click' and not has_pagination_max_pages:
            max_pages = NEXT_CLICK_DEFAULT_MAX_PAGES
        else:
            max_pages = int(pagination_cfg.get('max_pages') or rule.max_pages)
        if pagination_type == 'next_click' and max_pages == LEGACY_NEXT_CLICK_DEFAULT_MAX_PAGES:
            logger.info(
                'Browser crawler promote legacy next_click max_pages from {} to {}',
                LEGACY_NEXT_CLICK_DEFAULT_MAX_PAGES,
                NEXT_CLICK_DEFAULT_MAX_PAGES,
            )
            max_pages = NEXT_CLICK_DEFAULT_MAX_PAGES
        delay_ms = int(request_cfg.get('delay_ms') or rule.delay_ms)
        wait_until = browser_cfg.get('wait_until') or 'networkidle'
        wait_selector = browser_cfg.get('wait_selector') or item_selector
        timeout_ms = int(browser_cfg.get('timeout_ms') or 30000)
        detail_link_selector = list_cfg.get('detail_link_selector')

        if not url_template or not item_selector:
            raise CrawlerParseError('Missing url_template or item_selector')

        storage_state = to_playwright_storage_state(context.session_state, _origin_from_url(url_template))
        results: list[RawItem] = []
        logger.info(
            'Browser crawler start site={} pagination={} start_url={} item_selector={} wait_selector={} max_pages={} next_selector={}',
            rule.site_name,
            pagination_type,
            url_template.replace('{page}', '1'),
            item_selector,
            wait_selector,
            max_pages,
            list_cfg.get('next_selector') or pagination_cfg.get('next_selector') or '',
        )

        async with async_playwright() as p:
            browser = await launch_chromium(p, headless=True)
            try:
                page_context = await browser.new_context(storage_state=storage_state)
                page = await page_context.new_page()
                if pagination_type == 'next_click':
                    return await self._fetch_by_next_click(
                        page,
                        url_template.replace('{page}', '1'),
                        rule,
                        context,
                        item_selector,
                        fields,
                        list_cfg.get('next_selector') or pagination_cfg.get('next_selector'),
                        max_pages,
                        delay_ms,
                        wait_until,
                        wait_selector,
                        timeout_ms,
                    )

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

    async def _fetch_by_next_click(
        self,
        page,
        start_url: str,
        rule: CrawlRuleModel,
        context: RuntimeContext,
        item_selector: str,
        fields: dict,
        next_selector: str | None,
        max_pages: int,
        delay_ms: int,
        wait_until: str,
        wait_selector: str,
        timeout_ms: int,
    ) -> list[RawItem]:
        if not next_selector:
            raise CrawlerParseError('Missing pagination.next_selector for next_click mode')

        logger.info(
            'Next-click crawl open start_url={} item_selector={} next_selector={} wait_selector={} fields={}',
            start_url,
            item_selector,
            next_selector,
            wait_selector,
            fields,
        )
        if context.task_id:
            await push_progress(context.task_id, 0, f'Opening start page: {start_url}')

        try:
            await page.goto(start_url, wait_until=wait_until, timeout=timeout_ms)
            if wait_selector:
                await page.wait_for_selector(wait_selector, timeout=timeout_ms)
        except PlaywrightTimeoutError as exc:
            logger.warning(
                'Next-click crawl render timeout url={} wait_until={} wait_selector={} timeout_ms={}',
                start_url,
                wait_until,
                wait_selector,
                timeout_ms,
            )
            raise CrawlerFetchError(
                f'Browser render timeout: {start_url}; wait_selector={wait_selector}',
                code='CRAWLER_BROWSER_TIMEOUT',
                stage='browser',
            ) from exc
        except Exception as exc:
            logger.exception('Next-click crawl failed while opening start page url={}', start_url)
            raise CrawlerFetchError(
                f'Browser render failed: {start_url}; {type(exc).__name__}: {exc}',
                code='CRAWLER_BROWSER_RENDER_FAILED',
                stage='browser',
            ) from exc

        results: list[RawItem] = []
        seen_items: set[str] = set()
        empty_unique_streak = 0
        for index in range(1, max_pages + 1):
            current_url = page.url
            selector_counts = await self._diagnose_selector_counts(page, item_selector, fields, next_selector)
            logger.info(
                'Next-click crawl question={} url={} selector_counts={}',
                index,
                current_url,
                selector_counts,
            )
            if context.task_id:
                pct = int((index - 1) / max_pages * 90)
                await push_progress(
                    context.task_id,
                    max(0, pct),
                    (
                        f'Rendering question {index}/{max_pages}; '
                        f'items={selector_counts.get("item", "?")}; '
                        f'next={selector_counts.get("next", "?")}'
                    ),
                )

            html = await page.content()
            page_items = self._parse_html(
                html,
                current_url,
                rule,
                item_selector,
                fields,
                detail_link_selector=None,
            )
            unique_items = []
            for item in page_items:
                marker = _raw_item_marker(item)
                if marker and marker not in seen_items:
                    seen_items.add(marker)
                    unique_items.append(item)
            logger.info(
                'Next-click crawl parsed question={} raw_items={} unique_items={} total_results={}',
                index,
                len(page_items),
                len(unique_items),
                len(results) + len(unique_items),
            )
            if unique_items:
                results.extend(unique_items)
                empty_unique_streak = 0
            elif index > 1:
                empty_unique_streak += 1
                logger.warning(
                    'Next-click crawl parsed no new unique item question={} empty_streak={} url={} selector_counts={}',
                    index,
                    empty_unique_streak,
                    current_url,
                    selector_counts,
                )
                if empty_unique_streak >= 3:
                    logger.warning(
                        'Next-click crawl stop: too many consecutive empty or duplicate items question={} url={} selector_counts={}',
                        index,
                        current_url,
                        selector_counts,
                    )
                    if context.task_id:
                        await push_progress(context.task_id, min(90, int(index / max_pages * 90)), 'Stopped: consecutive empty question items')
                    break
                if context.task_id:
                    await push_progress(context.task_id, min(90, int(index / max_pages * 90)), 'Skipped empty/duplicate question item; trying next')

            if index >= max_pages:
                logger.warning(
                    'Next-click crawl stop: reached max_pages={} total_results={} url={}',
                    max_pages,
                    len(results),
                    current_url,
                )
                if context.task_id:
                    await push_progress(context.task_id, 90, f'Stopped: reached max questions limit ({max_pages})')
                break

            try:
                next_locator = page.locator(next_selector)
                next_count = await next_locator.count()
                if next_count == 0:
                    logger.warning('Next-click crawl stop: next selector not found selector={} url={}', next_selector, current_url)
                    if context.task_id:
                        await push_progress(context.task_id, min(90, int(index / max_pages * 90)), 'Stopped: next button selector not found')
                    break
                next_button = next_locator.first
                disabled = await next_button.evaluate(
                    """(el) => Boolean(
                      el.disabled ||
                      el.getAttribute('aria-disabled') === 'true' ||
                      el.classList.contains('disabled')
                    )"""
                )
                if disabled:
                    logger.info('Next-click crawl stop: next button disabled selector={} url={}', next_selector, current_url)
                    if context.task_id:
                        await push_progress(context.task_id, min(90, int(index / max_pages * 90)), 'Stopped: next button disabled')
                    break
                logger.info('Next-click crawl click next question={} selector={} matches={}', index, next_selector, next_count)
                await next_button.click(timeout=timeout_ms)
                await page.wait_for_timeout(max(250, delay_ms))
                try:
                    await page.wait_for_load_state(wait_until, timeout=min(timeout_ms, 8000))
                except PlaywrightTimeoutError:
                    logger.debug('Next-click crawl load_state wait ignored wait_until={} url={}', wait_until, page.url)
                if wait_selector:
                    try:
                        await page.wait_for_selector(wait_selector, timeout=min(timeout_ms, 8000))
                    except PlaywrightTimeoutError:
                        logger.warning(
                            'Next-click crawl wait_selector not found after click selector={} url={}',
                            wait_selector,
                            page.url,
                        )
            except PlaywrightTimeoutError as exc:
                logger.warning(
                    'Next-click crawl next button timeout url={} next_selector={} timeout_ms={}',
                    current_url,
                    next_selector,
                    timeout_ms,
                )
                raise CrawlerFetchError(
                    f'Browser next click timeout: {current_url}; next_selector={next_selector}',
                    code='CRAWLER_BROWSER_TIMEOUT',
                    stage='browser',
                ) from exc
            except Exception as exc:
                logger.exception(
                    'Next-click crawl next button failed url={} next_selector={}',
                    current_url,
                    next_selector,
                )
                raise CrawlerFetchError(
                    f'Browser next click failed: {current_url}; next_selector={next_selector}; {type(exc).__name__}: {exc}',
                    code='CRAWLER_BROWSER_NEXT_CLICK_FAILED',
                    stage='browser',
                ) from exc

        return results

    async def _diagnose_selector_counts(
        self,
        page,
        item_selector: str,
        fields: dict,
        next_selector: str | None,
    ) -> dict[str, int | str]:
        selectors = {
            'item': item_selector,
            'content': fields.get('content'),
            'options': fields.get('options'),
            'answer': fields.get('answer'),
            'explanation': fields.get('explanation'),
            'next': next_selector,
        }
        counts: dict[str, int | str] = {}
        for name, selector in selectors.items():
            if not selector:
                continue
            try:
                counts[name] = await _count_first_matching_locator(page, selector)
            except Exception as exc:
                counts[name] = f'ERROR {type(exc).__name__}: {exc}'
        return counts

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
            item_nodes = _select_first_matching(soup, item_selector)
            logger.info(
                'Browser parse selector item_selector={} matched={} url={}',
                item_selector,
                len(item_nodes),
                url,
            )
            for item in item_nodes:
                raw = extract_raw_item(
                    item,
                    url=url,
                    rule=rule,
                    fields=fields,
                    detail_link_selector=detail_link_selector,
                    adapter='browser_rule',
                )
                if raw:
                    if len(item_nodes) == 1 and _has_missing_configured_fields(raw, fields):
                        root_raw = extract_raw_item(
                            soup,
                            url=url,
                            rule=rule,
                            fields=fields,
                            detail_link_selector=detail_link_selector,
                            adapter='browser_rule',
                        )
                        if root_raw:
                            raw = _merge_missing_raw_fields(raw, root_raw)
                    results.append(raw)
            if not results and item_nodes:
                logger.warning(
                    'Browser parse produced no items inside item_selector; retrying from document root. '
                    'This usually means field selectors are outside the selected item container. '
                    'url={} item_selector={} fields={}',
                    url,
                    item_selector,
                    fields,
                )
                raw = extract_raw_item(
                    soup,
                    url=url,
                    rule=rule,
                    fields=fields,
                    detail_link_selector=detail_link_selector,
                    adapter='browser_rule',
                )
                if raw:
                    logger.info('Browser parse fallback from document root succeeded url={} content_len={}', url, len(raw.content))
                    results.append(raw)
                else:
                    logger.warning(
                        'Browser parse fallback from document root still empty url={} field_counts={}',
                        url,
                        _soup_selector_counts(soup, fields),
                    )
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


def _soup_selector_counts(soup, fields: dict) -> dict[str, int | str]:
    counts: dict[str, int | str] = {}
    for name, selector in {
        'content': fields.get('content'),
        'options': fields.get('options'),
        'answer': fields.get('answer'),
        'explanation': fields.get('explanation'),
    }.items():
        if not selector:
            continue
        try:
            counts[name] = _count_first_matching_selector(soup, selector)
        except Exception as exc:
            counts[name] = f'ERROR {type(exc).__name__}: {exc}'
    return counts


def _count_first_matching_selector(root, selector: str) -> int:
    for item in relaxed_selector_variants(selector, include_parents=True):
        try:
            count = len(root.select(item))
        except Exception:
            continue
        if count:
            return count
    return 0


async def _count_first_matching_locator(page, selector: str) -> int:
    for item in relaxed_selector_variants(selector, include_parents=True):
        try:
            count = await page.locator(item).count()
        except Exception:
            continue
        if count:
            return count
    return 0


def _select_first_matching(root, selector: str):
    for item in selector_variants(selector):
        try:
            nodes = root.select(item)
        except Exception:
            continue
        if nodes:
            return nodes
    return []


def _has_missing_configured_fields(raw: RawItem, fields: dict) -> bool:
    return any([
        bool(fields.get('title')) and not raw.title,
        bool(fields.get('options')) and not raw.options,
        bool(fields.get('answer')) and not raw.answer,
        bool(fields.get('explanation')) and not raw.explanation,
    ])


def _merge_missing_raw_fields(raw: RawItem, fallback: RawItem) -> RawItem:
    data = raw.model_dump()
    for field in ['title', 'options', 'answer', 'explanation', 'question_type', 'canonical_url']:
        if not data.get(field):
            data[field] = getattr(fallback, field)
    raw_meta = data.get('raw') if isinstance(data.get('raw'), dict) else {}
    fallback_meta = fallback.raw if isinstance(fallback.raw, dict) else {}
    data['raw'] = {**fallback_meta, **raw_meta}
    return RawItem(**data)


def _raw_item_marker(item: RawItem) -> str:
    options = '\n'.join(opt.strip() for opt in (item.options or []) if opt and opt.strip())
    return '|'.join([
        item.content.strip(),
        options,
        (item.answer or '').strip(),
        (item.explanation or '').strip(),
    ]).strip()
