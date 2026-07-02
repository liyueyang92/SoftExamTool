from typing import Any

import httpx

from modules.crawler.adapters.base import CrawlerAdapterBase
from modules.crawler.errors import CrawlerFetchError, CrawlerParseError
from modules.crawler.schemas import CrawlRuleModel, RawItem, RuntimeContext


def read_path(value: Any, path: str | None) -> Any:
    if not path:
        return value
    current = value
    for part in path.split('.'):
        if isinstance(current, list):
            current = current[int(part)]
        elif isinstance(current, dict):
            current = current.get(part)
        else:
            return None
    return current


class ApiJsonAdapter(CrawlerAdapterBase):
    async def fetch(self, rule: CrawlRuleModel, context: RuntimeContext) -> list[RawItem]:
        cfg = rule.effective_rule_json().get('api', rule.effective_rule_json())
        url = cfg.get('url') or rule.url_template
        method = str(cfg.get('method') or 'GET').upper()
        headers = cfg.get('headers') or {}
        body = cfg.get('body')
        items_path = cfg.get('items_path') or 'items'
        fields = cfg.get('fields') or {}
        if not url:
            raise CrawlerParseError('Missing API url')

        try:
            async with httpx.AsyncClient(follow_redirects=True) as client:
                resp = await client.request(method, url, headers=headers, json=body, timeout=20.0)
                resp.raise_for_status()
                data = resp.json()
        except Exception as exc:
            raise CrawlerFetchError(f'API request failed: {exc}') from exc

        rows = read_path(data, items_path)
        if not isinstance(rows, list):
            raise CrawlerParseError('JSON items_path did not resolve to a list')

        results: list[RawItem] = []
        for row in rows:
            content = read_path(row, fields.get('content')) or read_path(row, fields.get('title'))
            if not content:
                continue
            options = read_path(row, fields.get('options'))
            results.append(RawItem(
                title=read_path(row, fields.get('title')),
                content=str(content),
                options=options if isinstance(options, list) else None,
                answer=read_path(row, fields.get('answer')),
                explanation=read_path(row, fields.get('explanation')),
                source_url=read_path(row, fields.get('source_url')) or url,
                source_site=rule.site_name,
                raw={'adapter': 'api_json', 'row': row},
            ))
        return results
