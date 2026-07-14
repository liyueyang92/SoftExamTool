import re
from urllib.parse import urljoin
from urllib.parse import parse_qs, urlparse

from loguru import logger

from modules.crawler.schemas import CrawlRuleModel, RawItem
from modules.crawler.utils.selectors import attr_from, list_from, text_from
from modules.crawler.utils.image_downloader import extract_image_refs, rich_text_from


def extract_raw_item(
    item,
    *,
    url: str,
    rule: CrawlRuleModel,
    fields: dict,
    detail_link_selector: str | None = None,
    adapter: str,
) -> RawItem | None:
    content = rich_text_from(item, fields.get('content') or rule.question_field)
    if not content:
        return None

    # Extract plain text for fallback type detection
    content_plain = text_from(item, fields.get('content') or rule.question_field)

    options = list_from(item, fields.get('options') or rule.options_field)
    if not options:
        options = _fallback_options(item)

    # Also try rich text for options
    options_rich: list[str] = []
    options_selector = fields.get('options') or rule.options_field
    if options_selector:
        try:
            opt_nodes = item.select(options_selector)
            options_rich = [rich_text_from(node, None) for node in opt_nodes] if opt_nodes else []
            # Merge: prefer rich versions when available
            if options_rich and len(options_rich) == len(options):
                options = options_rich
        except Exception:
            pass

    # Collect image references from the item element
    image_refs = extract_image_refs(item, url)
    if image_refs:
        logger.info('[Crawler:Extract] {} image ref(s) in item url={}: {}',
                    len(image_refs), url[:100],
                    [r.src_url[:80] for r in image_refs[:5]])

    detail_href = attr_from(item, detail_link_selector, 'href') if detail_link_selector else ''
    source_url = urljoin(url, detail_href) if detail_href else url
    canonical_href = attr_from(item, fields.get('canonical_url'), 'href') if fields.get('canonical_url') else ''
    return RawItem(
        title=text_from(item, fields.get('title')) or None,
        content=content,
        question_type=_infer_question_type(rule, fields, url, item, options),
        options=options or None,
        answer=text_from(item, fields.get('answer') or rule.answer_field) or None,
        explanation=text_from(item, fields.get('explanation') or rule.expl_field) or None,
        source_url=source_url,
        source_site=rule.site_name,
        canonical_url=urljoin(url, canonical_href) if canonical_href else None,
        image_refs=image_refs,
        raw={'adapter': adapter},
    )


def _infer_question_type(rule: CrawlRuleModel, fields: dict, url: str, item, options: list[str]) -> str | None:
    configured = _normalize_question_type(fields.get('question_type'))
    if configured:
        return configured

    cfg = rule.effective_rule_json()
    for value in (
        cfg.get('question_type'),
        cfg.get('type'),
        cfg.get('list', {}).get('question_type') if isinstance(cfg.get('list'), dict) else None,
    ):
        configured = _normalize_question_type(value)
        if configured:
            return configured

    selector_text = text_from(item, fields.get('question_type_selector'))
    inferred = _infer_question_type_from_text(selector_text)
    if inferred:
        return inferred

    try:
        page_text = item.get_text(' ', strip=True)
    except Exception:
        page_text = ''
    inferred = _infer_question_type_from_text(page_text)
    if inferred:
        return inferred

    try:
        parsed = urlparse(url)
        query_text = parsed.query
        if not query_text and '?' in parsed.fragment:
            query_text = parsed.fragment.split('?', 1)[1]
        query = parse_qs(query_text)
    except Exception:
        return None

    question_type = (query.get('questionType') or query.get('question_type') or [''])[0]
    inferred = _normalize_question_type(question_type)
    if inferred:
        return inferred

    if options:
        return 'single'
    return None


def _normalize_question_type(value) -> str | None:
    text = str(value or '').strip().lower()
    return {
        '1': 'single',
        'single': 'single',
        'danxuan': 'single',
        '单选': 'single',
        '单选题': 'single',
        '2': 'multiple',
        'multiple': 'multiple',
        'multi': 'multiple',
        'duoxuan': 'multiple',
        '多选': 'multiple',
        '多选题': 'multiple',
        '3': 'case',
        'case': 'case',
        '案例': 'case',
        '案例题': 'case',
        '案例分析': 'case',
        '案例分析题': 'case',
        '4': 'essay',
        'essay': 'essay',
        '论文': 'essay',
        '论文题': 'essay',
    }.get(text)


def _infer_question_type_from_text(text: str) -> str | None:
    if not text:
        return None
    if '多选题' in text or '多项选择' in text:
        return 'multiple'
    if '单选题' in text or '单项选择' in text:
        return 'single'
    if '案例分析题' in text or '案例题' in text:
        return 'case'
    if '论文题' in text:
        return 'essay'
    return None


def _fallback_options(item) -> list[str]:
    candidates: list[str] = []
    for selector in ['.questionaw', '.option', '.options', '[class*=option]', '[class*=answer]']:
        try:
            nodes = item.select(selector)
        except Exception:
            continue
        for node in nodes:
            text = node.get_text(' ', strip=True)
            if _looks_like_options(text):
                candidates.append(text)
        if candidates:
            return candidates
    text = item.get_text(' ', strip=True)
    return [text] if _looks_like_options(text) else []


def _looks_like_options(text: str) -> bool:
    if not text:
        return False
    patterns = [
        r'(?<![A-Za-z0-9])([A-H])\s*[\.\uFF0E\u3001:：\)\）]',
        r'(?<![A-Za-z0-9])([A-H])(?=\s+\S)',
        r'(?<![A-Za-z0-9])([A-H])(?=[\u4e00-\u9fff])',
    ]
    for pattern in patterns:
        labels = re.findall(pattern, text)
        if len(labels) >= 2 and labels[0] == 'A':
            return True
    return False
