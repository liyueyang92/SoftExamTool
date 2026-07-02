import httpx

from modules.crawler.auth.session_state import to_playwright_storage_state
from modules.crawler.errors import CrawlerFetchError, CrawlerParseError
from modules.crawler.schemas import CrawlRuleModel, InspectLoadResponse, InspectNode, RuntimeContext
from modules.crawler.utils.ua import random_user_agent

try:
    from bs4 import BeautifulSoup
    BS4_AVAILABLE = True
except ImportError:
    BeautifulSoup = None
    BS4_AVAILABLE = False

try:
    from playwright.async_api import TimeoutError as PlaywrightTimeoutError
    from playwright.async_api import async_playwright
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PlaywrightTimeoutError = Exception
    async_playwright = None
    PLAYWRIGHT_AVAILABLE = False


MAX_SNAPSHOT_CHARS = 280_000
MAX_NODE_COUNT = 220


async def load_page_snapshot(
    rule: CrawlRuleModel,
    context: RuntimeContext,
    url: str | None = None,
) -> InspectLoadResponse:
    if not BS4_AVAILABLE or BeautifulSoup is None:
        raise CrawlerParseError('beautifulsoup4/lxml is not installed')

    target_url = _resolve_url(rule, url)
    if rule.adapter == 'browser_rule':
        html = await _load_with_browser(rule, context, target_url)
    else:
        html = await _load_with_http(context, target_url)

    soup = BeautifulSoup(html, 'lxml')
    _sanitize_soup(soup)
    title = soup.title.get_text(strip=True) if soup.title else ''
    snapshot = str(soup)
    if len(snapshot) > MAX_SNAPSHOT_CHARS:
        body = soup.body or soup
        snapshot = str(body)[:MAX_SNAPSHOT_CHARS]
    nodes = collect_inspect_nodes(snapshot)
    return InspectLoadResponse(
        url=target_url,
        adapter=rule.adapter,
        html=snapshot,
        title=title,
        nodes=nodes,
    )


def collect_inspect_nodes(html: str) -> list[InspectNode]:
    if not BS4_AVAILABLE or BeautifulSoup is None:
        raise CrawlerParseError('beautifulsoup4/lxml is not installed')

    soup = BeautifulSoup(html, 'lxml')
    nodes: list[InspectNode] = []
    for element in soup.find_all(True):
        if element.name in {'html', 'head', 'meta', 'link', 'style', 'script'}:
            continue
        text = element.get_text(' ', strip=True)
        if not text and element.name not in {'a', 'img', 'input', 'button'}:
            continue
        selector = _selector_for(element)
        path = _path_for(element)
        try:
            match_count = len(soup.select(selector))
        except Exception:
            match_count = 0
        class_attr = element.get('class') or []
        classes = [str(item) for item in class_attr] if isinstance(class_attr, list) else []
        nodes.append(InspectNode(
            path=path,
            selector=selector,
            tag=str(element.name),
            text=text[:160],
            classes=classes[:6],
            id=str(element.get('id')) if element.get('id') else None,
            match_count=match_count,
        ))
        if len(nodes) >= MAX_NODE_COUNT:
            break
    return nodes


async def _load_with_http(context: RuntimeContext, url: str) -> str:
    headers = {'User-Agent': random_user_agent()}
    cookie_header = _cookie_header(context)
    if cookie_header:
        headers['Cookie'] = cookie_header
    try:
        async with httpx.AsyncClient(follow_redirects=True) as client:
            resp = await client.get(url, headers=headers, timeout=20.0)
            resp.raise_for_status()
            return resp.text
    except Exception as exc:
        raise CrawlerFetchError(f'Inspect page fetch failed: {url}') from exc


async def _load_with_browser(rule: CrawlRuleModel, context: RuntimeContext, url: str) -> str:
    if not PLAYWRIGHT_AVAILABLE or async_playwright is None:
        raise CrawlerFetchError(
            'Playwright is not installed. Run: pip install playwright && playwright install chromium',
            code='CRAWLER_BROWSER_RUNTIME_MISSING',
            stage='browser',
        )
    cfg = rule.effective_rule_json()
    browser_cfg = cfg.get('browser', {})
    wait_until = browser_cfg.get('wait_until') or 'networkidle'
    wait_selector = browser_cfg.get('wait_selector') or cfg.get('list', {}).get('item_selector') or rule.item_selector
    timeout_ms = int(browser_cfg.get('timeout_ms') or 30000)
    storage_state = to_playwright_storage_state(context.session_state, _origin_from_url(url))

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        try:
            page_context = await browser.new_context(storage_state=storage_state)
            page = await page_context.new_page()
            try:
                await page.goto(url, wait_until=wait_until, timeout=timeout_ms)
                if wait_selector:
                    await page.wait_for_selector(wait_selector, timeout=timeout_ms)
            except PlaywrightTimeoutError as exc:
                raise CrawlerFetchError(
                    f'Inspect browser render timeout: {url}',
                    code='CRAWLER_BROWSER_TIMEOUT',
                    stage='browser',
                ) from exc
            return await page.content()
        finally:
            await browser.close()


def _resolve_url(rule: CrawlRuleModel, url: str | None) -> str:
    if url:
        return url
    cfg = rule.effective_rule_json()
    template = cfg.get('list', {}).get('url_template') or rule.url_template
    if not template:
        raise CrawlerFetchError('Inspect URL is required', code='CRAWLER_INSPECT_URL_REQUIRED')
    return str(template).replace('{page}', '1')


def _sanitize_soup(soup) -> None:
    for tag in soup(['script', 'noscript', 'iframe', 'object', 'embed']):
        tag.decompose()
    for tag in soup.find_all(True):
        for attr in list(tag.attrs):
            attr_name = str(attr).lower()
            if attr_name.startswith('on') or attr_name in {'srcdoc'}:
                del tag.attrs[attr]


def _selector_for(element) -> str:
    element_id = element.get('id')
    if element_id:
        return f'#{_css_escape(str(element_id))}'

    classes = element.get('class') or []
    stable_classes = [
        str(item)
        for item in classes
        if item and not str(item).startswith(('css-', 'sc-', 'jsx-'))
    ][:3]
    base = str(element.name)
    if stable_classes:
        base += ''.join(f'.{_css_escape(item)}' for item in stable_classes)

    parent = element.parent
    if not parent or not getattr(parent, 'find_all', None) or parent.name in {'[document]', 'html'}:
        return base

    siblings = [s for s in parent.find_all(element.name, recursive=False)]
    if len(siblings) > 1:
        index = siblings.index(element) + 1
        base = f'{base}:nth-of-type({index})'

    parent_selector = _selector_for(parent) if parent.name not in {'body', 'html'} else str(parent.name)
    return f'{parent_selector} > {base}'


def _path_for(element) -> str:
    parts: list[str] = []
    cursor = element
    while cursor and getattr(cursor, 'name', None) and cursor.name != '[document]':
        parent = cursor.parent
        if parent and getattr(parent, 'find_all', None):
            siblings = [s for s in parent.find_all(cursor.name, recursive=False)]
            index = siblings.index(cursor) + 1 if cursor in siblings else 1
        else:
            index = 1
        parts.append(f'{cursor.name}[{index}]')
        cursor = parent
    return '/'.join(reversed(parts))


def _cookie_header(context: RuntimeContext) -> str:
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


def _origin_from_url(url: str) -> str | None:
    if not url:
        return None
    import re
    match = re.match(r'^(https?://[^/]+)', url)
    return match.group(1) if match else None


def _css_escape(value: str) -> str:
    return value.replace('\\', '\\\\').replace('"', '\\"').replace('.', '\\.').replace(':', '\\:')
