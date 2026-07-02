from typing import Any


def text_from(element: Any, selector: str | None) -> str:
    if not selector:
        return ''
    found = element.select_one(selector)
    return found.get_text(strip=True) if found else ''


def list_from(element: Any, selector: str | None) -> list[str]:
    if not selector:
        return []
    return [e.get_text(strip=True) for e in element.select(selector)]


def attr_from(element: Any, selector: str | None, attr: str) -> str:
    if not selector:
        return ''
    found = element.select_one(selector)
    return str(found.get(attr, '')).strip() if found else ''
