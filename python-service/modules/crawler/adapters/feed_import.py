import httpx

from modules.crawler.adapters.base import CrawlerAdapterBase
from modules.crawler.errors import CrawlerFetchError, CrawlerParseError
from modules.crawler.schemas import CrawlRuleModel, RawItem, RuntimeContext

try:
    import feedparser
    FEEDPARSER_AVAILABLE = True
except ImportError:
    FEEDPARSER_AVAILABLE = False


class FeedImportAdapter(CrawlerAdapterBase):
    async def fetch(self, rule: CrawlRuleModel, context: RuntimeContext) -> list[RawItem]:
        if not FEEDPARSER_AVAILABLE:
            raise CrawlerParseError('feedparser is not installed')
        cfg = rule.effective_rule_json().get('feed', rule.effective_rule_json())
        url = cfg.get('url') or rule.url_template
        if not url:
            raise CrawlerParseError('Missing feed url')

        try:
            async with httpx.AsyncClient(follow_redirects=True) as client:
                resp = await client.get(url, timeout=20.0)
                resp.raise_for_status()
        except Exception as exc:
            raise CrawlerFetchError(f'Feed request failed: {exc}') from exc

        parsed = feedparser.parse(resp.text)
        results: list[RawItem] = []
        for entry in parsed.entries:
            content = getattr(entry, 'summary', '') or getattr(entry, 'title', '')
            if not content:
                continue
            results.append(RawItem(
                title=getattr(entry, 'title', None),
                content=content,
                source_url=getattr(entry, 'link', url),
                source_site=rule.site_name,
                raw={'adapter': 'feed_import'},
            ))
        return results
