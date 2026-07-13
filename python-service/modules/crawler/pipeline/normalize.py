import hashlib
import re

from modules.crawler.errors import CrawlerNormalizeError
from modules.crawler.schemas import NormalizedItem, RawItem


def normalize_item(item: RawItem) -> NormalizedItem:
    content = ' '.join(item.content.split())
    if not content:
        raise CrawlerNormalizeError('Empty content after normalization')

    options = _normalize_options(item.options or [])
    question_type = item.question_type or ('single' if options else 'essay')
    options_source = '|'.join(options)
    hash_source = f'{content}|{options_source}|{item.answer or ""}|{item.source_url or ""}'
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
        image_refs=item.image_refs or [],
        raw=item.raw,
    )


def normalize_items(items: list[RawItem]) -> list[NormalizedItem]:
    return [normalize_item(item) for item in items]


def _normalize_options(raw_options: list[str]) -> list[str]:
    options = [' '.join(opt.split()) for opt in raw_options if opt and opt.strip()]
    normalized: list[str] = []
    for option in options:
        split_options = _split_combined_options(option)
        if len(split_options) > 1:
            normalized.extend(split_options)
        else:
            normalized.append(option)
    return _dedupe_options(normalized)


def _split_combined_options(text: str) -> list[str]:
    matches = _option_marker_matches(text)
    if len(matches) <= 1:
        return []
    result: list[str] = []
    for index, match in enumerate(matches):
        start = match.start()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        value = text[start:end].strip()
        if value:
            result.append(value)
    return result


def _option_marker_matches(text: str) -> list[re.Match[str]]:
    patterns = [
        r'(?<![A-Za-z0-9])([A-H])\s*[\.\uFF0E\u3001:：\)\）]',
        r'(?<![A-Za-z0-9])([A-H])(?=\s+\S)',
        r'(?<![A-Za-z0-9])([A-H])(?=[\u4e00-\u9fff])',
    ]
    for pattern in patterns:
        matches = list(re.finditer(pattern, text))
        if _looks_like_option_sequence(matches):
            return matches
    return []


def _looks_like_option_sequence(matches: list[re.Match[str]]) -> bool:
    if len(matches) < 2:
        return False
    labels = [match.group(1) for match in matches]
    indexes = [ord(label) - ord('A') for label in labels]
    return indexes[0] == 0 and all(curr > prev for prev, curr in zip(indexes, indexes[1:]))


def _dedupe_options(options: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for option in options:
        key = option.strip()
        if not key or key in seen:
            continue
        seen.add(key)
        result.append(key)
    return result
