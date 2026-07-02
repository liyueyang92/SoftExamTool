import hashlib

from modules.crawler.errors import CrawlerNormalizeError
from modules.crawler.schemas import NormalizedItem, RawItem


def normalize_item(item: RawItem) -> NormalizedItem:
    content = ' '.join(item.content.split())
    if not content:
        raise CrawlerNormalizeError('Empty content after normalization')

    options = [opt.strip() for opt in (item.options or []) if opt and opt.strip()]
    question_type = item.question_type or ('single' if options else 'essay')
    hash_source = f'{content}|{item.answer or ""}|{item.source_url or ""}'
    content_hash = hashlib.md5(hash_source.encode('utf-8')).hexdigest()

    return NormalizedItem(
        title=item.title,
        content=content,
        content_type=item.content_type,
        type=question_type,
        options=options or None,
        answer=item.answer or None,
        explanation=item.explanation or None,
        knowledge_tags=item.knowledge_tags or [],
        source_url=item.canonical_url or item.source_url,
        source_site=item.source_site,
        content_hash=content_hash,
        raw=item.raw,
    )


def normalize_items(items: list[RawItem]) -> list[NormalizedItem]:
    return [normalize_item(item) for item in items]
