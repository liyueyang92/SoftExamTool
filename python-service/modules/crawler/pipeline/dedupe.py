from modules.crawler.schemas import NormalizedItem


def dedupe_items(items: list[NormalizedItem]) -> list[NormalizedItem]:
    seen: set[str] = set()
    result: list[NormalizedItem] = []
    for item in items:
        if item.content_hash in seen:
            continue
        seen.add(item.content_hash)
        result.append(item)
    return result
