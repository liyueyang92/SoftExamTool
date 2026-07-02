import asyncio

from fastapi import APIRouter, HTTPException
from loguru import logger

from modules.crawler.errors import CrawlerError
from modules.crawler.schemas import RunCrawlRequest, RuntimeContext, TestCrawlRequest
from modules.crawler.service import crawl
from modules.progress import push_complete, push_error, push_progress

router = APIRouter(prefix='/crawler', tags=['crawler'])


@router.post('/test')
async def test_crawl(req: TestCrawlRequest):
    try:
        manual_input = dict(req.manual_input or {})
        if req.test_url:
            manual_input['url'] = req.test_url
        results = await crawl(req.rule, RuntimeContext(
            account_alias=req.account_alias,
            manual_input=manual_input or None,
        ))
        return {'count': len(results), 'samples': [item.model_dump() for item in results[:3]]}
    except CrawlerError as exc:
        raise HTTPException(
            400,
            {'code': exc.code, 'stage': exc.stage, 'message': str(exc)},
        ) from exc


@router.post('/run')
async def run_crawl(req: RunCrawlRequest):
    asyncio.create_task(_do_crawl(req))
    return {'started': True}


async def _do_crawl(req: RunCrawlRequest) -> None:
    try:
        await push_progress(req.task_id, 0, 'Starting crawler')
        results = await crawl(req.rule, RuntimeContext(
            task_id=req.task_id,
            rule_id=req.rule_id,
            target_group_id=req.target_group_id,
            account_alias=req.account_alias,
            manual_input=req.manual_input,
        ))
        await push_progress(req.task_id, 95, 'Finalizing results')
        await push_complete(req.task_id, {
            'questions': [item.model_dump() for item in results],
            'total_found': len(results),
            'rule_id': req.rule_id,
            'target_group_id': req.target_group_id,
            'new_group': req.new_group.model_dump() if req.new_group else None,
        })
    except CrawlerError as exc:
        logger.error('Crawl {} failed: {}', req.task_id, exc)
        await push_error(req.task_id, {'code': exc.code, 'stage': exc.stage, 'message': str(exc)})
    except Exception as exc:
        logger.error('Crawl {} failed: {}', req.task_id, exc)
        await push_error(req.task_id, {'code': 'CRAWLER_ERROR', 'stage': 'unknown', 'message': str(exc)})
