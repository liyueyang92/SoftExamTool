import asyncio
import hashlib
import random
from typing import Optional

from fastapi import APIRouter, HTTPException
from loguru import logger
from pydantic import BaseModel

try:
    from bs4 import BeautifulSoup
    BS4_AVAILABLE = True
except ImportError:
    BS4_AVAILABLE = False

import httpx
from modules.progress import push_progress, push_complete, push_error

router = APIRouter(prefix='/crawler', tags=['crawler'])

USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
]


class CrawlRuleModel(BaseModel):
    site_name: str
    url_template: str     # e.g. "https://example.com/q?page={page}"
    item_selector: str    # CSS selector for each question container
    question_field: str   # CSS selector within container for question text
    options_field: Optional[str] = None
    answer_field: Optional[str] = None
    expl_field: Optional[str] = None
    max_pages: int = 5
    delay_ms: int = 1500


def _require_bs4():
    if not BS4_AVAILABLE:
        raise HTTPException(400, 'beautifulsoup4 未安装，请运行: pip install beautifulsoup4 lxml')


def _text(el, selector: Optional[str]) -> str:
    if not selector:
        return ''
    found = el.select_one(selector)
    return found.get_text(strip=True) if found else ''


def _list(el, selector: Optional[str]) -> list:
    if not selector:
        return []
    return [e.get_text(strip=True) for e in el.select(selector)]


async def _fetch_page(client: httpx.AsyncClient, url: str, rule: CrawlRuleModel) -> list:
    headers = {'User-Agent': random.choice(USER_AGENTS)}
    try:
        resp = await client.get(url, headers=headers, timeout=20.0, follow_redirects=True)
        resp.raise_for_status()
    except Exception as exc:
        logger.warning('Fetch failed {}: {}', url, exc)
        return []

    soup = BeautifulSoup(resp.text, 'lxml')
    results = []
    for item in soup.select(rule.item_selector):
        content = _text(item, rule.question_field)
        if not content:
            continue
        options = _list(item, rule.options_field) if rule.options_field else []
        answer = _text(item, rule.answer_field)
        explanation = _text(item, rule.expl_field)
        results.append({
            'content': content,
            'options': options or None,
            'answer': answer or None,
            'explanation': explanation or None,
            'content_hash': hashlib.md5(content.encode()).hexdigest(),
            'source_url': url,
            'type': 'single' if options else 'essay',
        })
    return results


class TestCrawlRequest(BaseModel):
    rule: CrawlRuleModel
    test_url: str


@router.post('/test')
async def test_crawl(req: TestCrawlRequest):
    _require_bs4()
    async with httpx.AsyncClient() as client:
        results = await _fetch_page(client, req.test_url, req.rule)
    return {'count': len(results), 'samples': results[:3]}


class RunCrawlRequest(BaseModel):
    rule: CrawlRuleModel
    task_id: str
    rule_id: str


@router.post('/run')
async def run_crawl(req: RunCrawlRequest):
    _require_bs4()
    asyncio.create_task(_do_crawl(req))
    return {'started': True}


async def _do_crawl(req: RunCrawlRequest) -> None:
    rule = req.rule
    all_results: list = []
    seen: set = set()

    try:
        async with httpx.AsyncClient() as client:
            for page in range(1, rule.max_pages + 1):
                url = rule.url_template.replace('{page}', str(page))
                pct = int((page - 1) / rule.max_pages * 90)
                await push_progress(req.task_id, pct, f'抓取第 {page}/{rule.max_pages} 页…')

                page_results = await _fetch_page(client, url, rule)
                if not page_results:
                    break

                for r in page_results:
                    h = r['content_hash']
                    if h not in seen:
                        seen.add(h)
                        all_results.append(r)

                delay = max(200, rule.delay_ms + random.randint(-300, 300))
                await asyncio.sleep(delay / 1000)

        await push_complete(req.task_id, {
            'questions': all_results,
            'total_found': len(all_results),
            'rule_id': req.rule_id,
        })
    except Exception as exc:
        logger.error('Crawl {} failed: {}', req.task_id, exc)
        await push_error(req.task_id, str(exc))
