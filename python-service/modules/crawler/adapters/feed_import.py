import httpx
import xml.etree.ElementTree as ET

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
            return self._parse_with_stdlib(resp_text=await self._fetch_text(rule), rule=rule)
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

    async def _fetch_text(self, rule: CrawlRuleModel) -> str:
        cfg = rule.effective_rule_json().get('feed', rule.effective_rule_json())
        url = cfg.get('url') or rule.url_template
        if not url:
            raise CrawlerParseError('Missing feed url')
        try:
            async with httpx.AsyncClient(follow_redirects=True) as client:
                resp = await client.get(url, timeout=20.0)
                resp.raise_for_status()
                return resp.text
        except Exception as exc:
            raise CrawlerFetchError(f'Feed request failed: {exc}') from exc

    def _parse_with_stdlib(self, resp_text: str, rule: CrawlRuleModel) -> list[RawItem]:
        try:
            root = ET.fromstring(resp_text)
        except Exception as exc:
            raise CrawlerParseError('Feed XML parse failed') from exc

        results: list[RawItem] = []
        for item in root.findall('.//item'):
            title = item.findtext('title')
            link = item.findtext('link')
            content = item.findtext('description') or title or ''
            if not content:
                continue
            results.append(RawItem(
                title=title,
                content=content,
                source_url=link,
                source_site=rule.site_name,
                raw={'adapter': 'feed_import', 'parser': 'stdlib'},
            ))
        for entry in root.findall('.//{http://www.w3.org/2005/Atom}entry'):
            title = entry.findtext('{http://www.w3.org/2005/Atom}title')
            content = entry.findtext('{http://www.w3.org/2005/Atom}summary') or entry.findtext('{http://www.w3.org/2005/Atom}content') or title or ''
            link_el = entry.find('{http://www.w3.org/2005/Atom}link')
            link = link_el.get('href') if link_el is not None else None
            if content:
                results.append(RawItem(
                    title=title,
                    content=content,
                    source_url=link,
                    source_site=rule.site_name,
                    raw={'adapter': 'feed_import', 'parser': 'stdlib'},
                ))
        return results
