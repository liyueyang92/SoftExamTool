from modules.crawler.errors import CrawlerParseError
from modules.crawler.schemas import SelectorCandidate, SuggestSelectorResponse

try:
    from bs4 import BeautifulSoup
    BS4_AVAILABLE = True
except ImportError:
    BeautifulSoup = None
    BS4_AVAILABLE = False


def suggest_selectors(
    html: str,
    *,
    path: str | None = None,
    selector: str | None = None,
    scope_selector: str | None = None,
) -> SuggestSelectorResponse:
    if not BS4_AVAILABLE or BeautifulSoup is None:
        raise CrawlerParseError('beautifulsoup4/lxml is not installed')

    soup = BeautifulSoup(html, 'lxml')
    node = None
    if selector:
        try:
            node = soup.select_one(selector)
        except Exception:
            node = None
    if node is None and path:
        node = _node_by_path(soup, path)
    if node is None:
        raise CrawlerParseError('Selected node was not found', code='CRAWLER_SELECTOR_NODE_NOT_FOUND')

    candidates: list[tuple[str, str]] = []
    for stable_node in _stable_nodes(node):
        node_id = stable_node.get('id')
        if node_id:
            candidates.append(('css', f'#{_css_escape(str(node_id))}'))

        classes = [str(item) for item in (stable_node.get('class') or []) if item]
        stable_classes = _stable_classes(classes)
        if stable_classes:
            candidates.append(('css', '.' + _css_escape(stable_classes[0])))
            candidates.append(('css', f'{stable_node.name}.{_css_escape(stable_classes[0])}'))
            candidates.append(('css', '.' + '.'.join(_css_escape(item) for item in stable_classes[:2])))
            candidates.append(('css', f'{stable_node.name}' + ''.join(f'.{_css_escape(item)}' for item in stable_classes[:3])))

        attr_selector = _stable_attr_selector(stable_node)
        if attr_selector:
            candidates.append(('css', attr_selector))

    text = node.get_text(' ', strip=True)
    if text and node.name in {'a', 'button', 'span', 'strong', 'h1', 'h2', 'h3', 'p'}:
        candidates.append(('css', _selector_with_position(node, shallow=True)))

    candidates.append(('css', _selector_with_position(node, shallow=True)))
    candidates.append(('css', _selector_with_position(node, shallow=False)))
    candidates.append(('xpath', _xpath_for(node, shallow=True)))
    candidates.append(('xpath', _xpath_for(node, shallow=False)))

    if scope_selector:
        scoped_candidates = [
            (kind, f'{scope_selector} {item}')
            for kind, item in candidates
            if kind == 'css' and not item.startswith(scope_selector)
        ]
        candidates = [
            *candidates,
            *scoped_candidates,
        ]

    result: list[SelectorCandidate] = []
    seen: set[str] = set()
    for kind, item in candidates:
        if not item or item in seen:
            continue
        seen.add(item)
        if kind == 'xpath':
            matches = [node]
        else:
            try:
                matches = soup.select(item)
            except Exception:
                continue
        result.append(SelectorCandidate(
            selector=item,
            match_count=len(matches),
            text_sample=(matches[0].get_text(' ', strip=True) if matches else '')[:140],
            stability=_stability(item, len(matches)),
            kind=kind,
        ))

    result.sort(key=lambda item: _candidate_rank(item.selector, item.match_count))
    return SuggestSelectorResponse(candidates=result[:8])


def _stable_nodes(node):
    current = node
    depth = 0
    while current and getattr(current, 'name', None) and current.name not in {'[document]', 'body', 'html'} and depth < 5:
        if current.get('id') or _stable_classes(current.get('class') or []) or _stable_attr_selector(current):
            yield current
        current = current.parent
        depth += 1


def _stable_classes(classes) -> list[str]:
    return [
        str(item)
        for item in classes
        if item and not str(item).startswith(('css-', 'sc-', 'jsx-', 'crawler-capture-picked'))
        and str(item) not in {'active', 'selected', 'disabled', 'hover', 'focus'}
    ]


def _stable_attr_selector(node) -> str:
    for attr in ['data-testid', 'data-test', 'data-cy', 'name', 'aria-label', 'title']:
        value = node.get(attr)
        if value:
            return f'{node.name}[{attr}="{_css_escape(str(value))}"]'
    return ''


def _node_by_path(soup, path: str):
    current = soup
    for part in path.split('/'):
        if '[' not in part or not part.endswith(']'):
            return None
        tag = part.split('[', 1)[0]
        try:
            index = int(part.rsplit('[', 1)[1][:-1]) - 1
        except ValueError:
            return None
        children = current.find_all(tag, recursive=False)
        if index < 0 or index >= len(children):
            return None
        current = children[index]
    return current


def _selector_with_position(node, *, shallow: bool) -> str:
    parts: list[str] = []
    current = node
    while current and getattr(current, 'name', None) and current.name != '[document]':
        part = str(current.name)
        classes = [str(item) for item in (current.get('class') or []) if item and not str(item).startswith(('css-', 'sc-', 'jsx-'))]
        if classes:
            part += ''.join(f'.{_css_escape(item)}' for item in classes[:2])
        parent = current.parent
        if parent and getattr(parent, 'find_all', None):
            siblings = [s for s in parent.find_all(current.name, recursive=False)]
            if len(siblings) > 1:
                part += f':nth-of-type({siblings.index(current) + 1})'
        parts.append(part)
        if shallow and len(parts) >= 2:
            break
        current = parent
        if current and current.name == 'body':
            parts.append('body')
            break
    return ' > '.join(reversed(parts))


def _xpath_for(node, *, shallow: bool) -> str:
    parts: list[str] = []
    current = node
    while current and getattr(current, 'name', None) and current.name != '[document]':
        parent = current.parent
        if parent and getattr(parent, 'find_all', None):
            siblings = [s for s in parent.find_all(current.name, recursive=False)]
            index = siblings.index(current) + 1 if current in siblings else 1
        else:
            index = 1
        parts.append(f'{current.name}[{index}]')
        if shallow and len(parts) >= 2:
            break
        current = parent
    return '//' + '/'.join(reversed(parts)) if shallow else '/' + '/'.join(reversed(parts))


def _stability(selector: str, match_count: int) -> str:
    if selector.startswith('//') or selector.startswith('/'):
        return 'low'
    if selector.startswith('#') or (match_count == 1 and ':nth-of-type' not in selector and '>' not in selector):
        return 'high'
    if ':nth-of-type' in selector:
        return 'low'
    return 'medium'


def _candidate_rank(selector: str, match_count: int) -> tuple[int, int, int]:
    if selector.startswith('//') or selector.startswith('/'):
        quality = 5
    elif selector.startswith('#'):
        quality = 0
    elif ':nth-of-type' not in selector and '>' not in selector and match_count > 0:
        quality = 1
    elif ':nth-of-type' not in selector and match_count > 0:
        quality = 2
    else:
        quality = 4
    return (quality, len(selector), -match_count)


def _css_escape(value: str) -> str:
    return value.replace('\\', '\\\\').replace('"', '\\"').replace('.', '\\.').replace(':', '\\:')
