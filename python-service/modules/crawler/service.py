import os
import tempfile

from loguru import logger

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
    items_with_refs = sum(1 for r in raw_items if r.image_refs)
    logger.info('[Crawler:Service] Fetched {} raw items, {} with image_refs',
                len(raw_items), items_with_refs)
    items = dedupe_items(normalize_items(raw_items))
    logger.info('[Crawler:Service] After normalize+dedupe: {} items', len(items))

    # Download images for items that have image_refs.
    crawler_tmp_root = os.path.join(tempfile.gettempdir(), 'soft_exam_crawler')
    task_dir = os.path.join(crawler_tmp_root, context.task_id or 'default')
    os.makedirs(task_dir, exist_ok=True)

    download_count = 0
    for item in items:
        if item.image_refs:
            before = [r.local_path for r in item.image_refs]
            item.image_refs = await download_images(item.image_refs, task_dir)
            after = [r.local_path for r in item.image_refs]
            new_paths = [p for p in after if p and p not in before]
            if new_paths:
                download_count += 1
                logger.info('[Crawler:Service] Item hash={} got {} downloaded image(s): {}',
                            item.content_hash[:12], len(new_paths), new_paths)
    logger.info('[Crawler:Service] Downloaded images for {}/{} items, dir={}',
                download_count, len(items), task_dir)

    return items
