from bs4 import BeautifulSoup

from modules.crawler.adapters.base import CrawlerAdapterBase
from modules.crawler.schemas import CrawlRuleModel, RawItem, RuntimeContext


class ManualClipAdapter(CrawlerAdapterBase):
    async def fetch(self, rule: CrawlRuleModel, context: RuntimeContext) -> list[RawItem]:
        manual = context.manual_input or {}
        text = str(manual.get('text') or '').strip()
        html = str(manual.get('html') or '').strip()
        url = str(manual.get('url') or '').strip() or None
        title = str(manual.get('title') or '').strip() or None

        if html and not text:
            soup = BeautifulSoup(html, 'lxml')
            text = soup.get_text('\n', strip=True)

        if not text:
            return []

        return [RawItem(
            title=title,
            content=text,
            source_url=url,
            source_site=rule.site_name,
            raw={'adapter': 'manual_clip'},
        )]
