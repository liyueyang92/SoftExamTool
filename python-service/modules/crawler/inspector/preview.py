from modules.crawler.errors import CrawlerParseError
from modules.crawler.inspector.page_loader import load_page_snapshot
from modules.crawler.schemas import CrawlRuleModel, InspectPreviewResponse, RawItem, RuntimeContext
from modules.crawler.utils.extract import extract_raw_item

try:
    from bs4 import BeautifulSoup
    BS4_AVAILABLE = True
except ImportError:
    BeautifulSoup = None
    BS4_AVAILABLE = False


async def preview_extraction(
    rule: CrawlRuleModel,
    context: RuntimeContext,
    *,
    html: str | None = None,
    url: str | None = None,
) -> InspectPreviewResponse:
    if not BS4_AVAILABLE or BeautifulSoup is None:
        raise CrawlerParseError('beautifulsoup4/lxml is not installed')

    snapshot_url = url or ''
    if html is None:
        loaded = await load_page_snapshot(rule, context, url)
        html = loaded.html
        snapshot_url = loaded.url
    cfg = rule.effective_rule_json()
    list_cfg = cfg.get('list', {})
    fields = list_cfg.get('fields', {})
    item_selector = list_cfg.get('item_selector') or rule.item_selector
    detail_link_selector = list_cfg.get('detail_link_selector')
    if not item_selector:
        raise CrawlerParseError('Missing item_selector')

    soup = BeautifulSoup(html, 'lxml')
    try:
        elements = soup.select(item_selector)
    except Exception as exc:
        raise CrawlerParseError(f'Invalid item selector: {item_selector}') from exc

    samples: list[RawItem] = []
    for element in elements[:5]:
        raw = extract_raw_item(
            element,
            url=snapshot_url,
            rule=rule,
            fields=fields,
            detail_link_selector=detail_link_selector,
            adapter=f'{rule.adapter}_preview',
        )
        if raw:
            samples.append(raw)

    selector_matches = {'item_selector': len(elements)}
    for key, selector in fields.items():
        if not selector:
            continue
        try:
            selector_matches[f'field:{key}'] = len(soup.select(selector))
        except Exception:
            selector_matches[f'field:{key}'] = 0

    return InspectPreviewResponse(
        count=len(elements),
        samples=samples,
        selector_matches=selector_matches,
    )
