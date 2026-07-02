from urllib.parse import urljoin

from modules.crawler.schemas import CrawlRuleModel, RawItem
from modules.crawler.utils.selectors import attr_from, list_from, text_from


def extract_raw_item(
    item,
    *,
    url: str,
    rule: CrawlRuleModel,
    fields: dict,
    detail_link_selector: str | None = None,
    adapter: str,
) -> RawItem | None:
    content = text_from(item, fields.get('content') or rule.question_field)
    if not content:
        return None
    options = list_from(item, fields.get('options') or rule.options_field)
    detail_href = attr_from(item, detail_link_selector, 'href') if detail_link_selector else ''
    source_url = urljoin(url, detail_href) if detail_href else url
    canonical_href = attr_from(item, fields.get('canonical_url'), 'href') if fields.get('canonical_url') else ''
    return RawItem(
        title=text_from(item, fields.get('title')) or None,
        content=content,
        options=options or None,
        answer=text_from(item, fields.get('answer') or rule.answer_field) or None,
        explanation=text_from(item, fields.get('explanation') or rule.expl_field) or None,
        source_url=source_url,
        source_site=rule.site_name,
        canonical_url=urljoin(url, canonical_href) if canonical_href else None,
        raw={'adapter': adapter},
    )
