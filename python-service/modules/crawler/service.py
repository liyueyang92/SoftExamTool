import tempfile

from modules.crawler.adapters.api_json import ApiJsonAdapter
from modules.crawler.adapters.base import CrawlerAdapterBase
from modules.crawler.adapters.browser_rule import BrowserRuleAdapter
from modules.crawler.adapters.feed_import import FeedImportAdapter
from modules.crawler.adapters.http_rule import HttpRuleAdapter
from modules.crawler.adapters.manual_clip import ManualClipAdapter
from modules.crawler.errors import CrawlerUnsupportedAdapterError
from modules.crawler.pipeline.dedupe import dedupe_items
from modules.crawler.pipeline.normalize import normalize_items
from modules.crawler.schemas import CrawlRuleModel, NormalizedItem, RuntimeContext
from modules.crawler.utils.image_downloader import download_images


ADAPTERS: dict[str, CrawlerAdapterBase] = {
    'http_rule': HttpRuleAdapter(),
    'browser_rule': BrowserRuleAdapter(),
    'api_json': ApiJsonAdapter(),
    'feed_import': FeedImportAdapter(),
    'manual_clip': ManualClipAdapter(),
}


async def crawl(rule: CrawlRuleModel, context: RuntimeContext) -> list[NormalizedItem]:
    adapter = ADAPTERS.get(rule.adapter)
    if not adapter:
        raise CrawlerUnsupportedAdapterError(f'Unsupported adapter: {rule.adapter}')
    raw_items = await adapter.fetch(rule, context)
    items = dedupe_items(normalize_items(raw_items))

    # Download images for items that have image_refs
    with tempfile.TemporaryDirectory() as tmpdir:
        for item in items:
            if item.image_refs:
                item.image_refs = await download_images(item.image_refs, tmpdir)

    return items
