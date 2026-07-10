import re
from typing import Any


CAPTURE_CLASS_RE = re.compile(r'\.crawler-capture-picked(?:-[A-Za-z0-9_-]+)?')


def selector_variants(selector: str | None) -> list[str]:
    if not selector:
        return []
    variants: list[str] = []
    _append_unique(variants, selector)
    cleaned = CAPTURE_CLASS_RE.sub('', selector)
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    _append_unique(variants, cleaned)
    return variants


def relaxed_selector_variants(selector: str | None, *, include_parents: bool = False) -> list[str]:
    variants: list[str] = []
    for item in selector_variants(selector):
        descendant = re.sub(r'\s*>\s*', ' ', item).strip()
        no_nth = re.sub(r':nth-of-type\(\d+\)', '', item).strip()
        no_nth = re.sub(r'\s+', ' ', no_nth)
        descendant_no_nth = re.sub(r':nth-of-type\(\d+\)', '', descendant).strip()
        descendant_no_nth = re.sub(r'\s+', ' ', descendant_no_nth)
        for candidate in [item, descendant, no_nth, descendant_no_nth]:
            _append_unique(variants, candidate)
            if include_parents:
                for parent in _direct_parent_selectors(candidate):
                    _append_unique(variants, parent)
    return variants


def text_from(element: Any, selector: str | None) -> str:
    for item in relaxed_selector_variants(selector, include_parents=True):
        try:
            found = element.select_one(item)
        except Exception:
            continue
        if found:
            return found.get_text(' ', strip=True)
    return ''


def list_from(element: Any, selector: str | None) -> list[str]:
    for item in relaxed_selector_variants(selector):
        try:
            found = element.select(item)
        except Exception:
            continue
        if found:
            return [e.get_text(' ', strip=True) for e in found]
    return []


def attr_from(element: Any, selector: str | None, attr: str) -> str:
    for item in selector_variants(selector):
        try:
            found = element.select_one(item)
        except Exception:
            continue
        if found:
            return str(found.get(attr, '')).strip()
    return ''


def _direct_parent_selectors(selector: str) -> list[str]:
    if '>' not in selector:
        return []
    parts = [part.strip() for part in selector.split('>') if part.strip()]
    parents: list[str] = []
    while len(parts) > 1:
        parts = parts[:-1]
        _append_unique(parents, ' > '.join(parts))
    return parents


def _append_unique(items: list[str], value: str | None) -> None:
    value = (value or '').strip()
    if value and value not in items:
        items.append(value)
