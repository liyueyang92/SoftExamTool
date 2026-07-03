import asyncio

from fastapi import APIRouter, HTTPException
from loguru import logger

from modules.crawler.errors import CrawlerError
from modules.crawler.inspector.page_loader import load_page_snapshot
from modules.crawler.inspector.preview import preview_extraction
from modules.crawler.inspector.selector_generator import suggest_selectors
from modules.crawler.schemas import (
    AuthStartRequest,
    AuthValidateRequest,
    CrawlerRuntimeStatus,
    InspectLoadRequest,
    InspectPreviewRequest,
    RunCrawlRequest,
    RuntimeContext,
    SuggestSelectorRequest,
    TestCrawlRequest,
)
from modules.crawler.runtime import check_browser_runtime
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
            session_state=req.session_state,
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


@router.get('/runtime/status')
async def runtime_status():
    result = await check_browser_runtime()
    return result.model_dump()


@router.post('/auth/start')
async def auth_start(req: AuthStartRequest):
    return {
        'started': False,
        'site_id': req.site_id,
        'account_alias': req.account_alias or 'default',
        'message': 'Desktop authorization is handled by Electron IPC crawler:authStart.',
    }


@router.get('/auth/{site_id}/sessions')
async def auth_sessions(site_id: str):
    return {'site_id': site_id, 'sessions': []}


@router.post('/auth/{site_id}/validate')
async def auth_validate(site_id: str, req: AuthValidateRequest):
    return {
        'site_id': site_id,
        'valid': bool(req.session_state),
        'message': 'Session validation with encrypted local state is handled by Electron.',
    }


@router.delete('/auth/{site_id}/sessions/{account_alias}')
async def auth_delete_session(site_id: str, account_alias: str):
    return {'site_id': site_id, 'account_alias': account_alias, 'deleted': False}


@router.post('/inspect/load')
async def inspect_load(req: InspectLoadRequest):
    try:
        result = await load_page_snapshot(req.rule, RuntimeContext(
            account_alias=req.account_alias,
            session_state=req.session_state,
        ), req.url)
        return result.model_dump()
    except CrawlerError as exc:
        raise HTTPException(
            400,
            {'code': exc.code, 'stage': exc.stage, 'message': str(exc)},
        ) from exc


@router.post('/inspect/suggest-selector')
async def inspect_suggest_selector(req: SuggestSelectorRequest):
    try:
        result = suggest_selectors(
            req.html,
            path=req.path,
            selector=req.selector,
            scope_selector=req.scope_selector,
        )
        return result.model_dump()
    except CrawlerError as exc:
        raise HTTPException(
            400,
            {'code': exc.code, 'stage': exc.stage, 'message': str(exc)},
        ) from exc


@router.post('/inspect/preview')
async def inspect_preview(req: InspectPreviewRequest):
    try:
        result = await preview_extraction(req.rule, RuntimeContext(
            account_alias=req.account_alias,
            session_state=req.session_state,
        ), html=req.html, url=req.url)
        return result.model_dump()
    except CrawlerError as exc:
        raise HTTPException(
            400,
            {'code': exc.code, 'stage': exc.stage, 'message': str(exc)},
        ) from exc


async def _do_crawl(req: RunCrawlRequest) -> None:
    attempts = max(1, req.retry_limit + 1)
    last_error: CrawlerError | Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            await push_progress(req.task_id, 0, f'Starting crawler (attempt {attempt}/{attempts})')
            results = await crawl(req.rule, RuntimeContext(
                task_id=req.task_id,
                rule_id=req.rule_id,
                target_group_id=req.target_group_id,
                account_alias=req.account_alias,
                session_state=req.session_state,
                manual_input=req.manual_input,
            ))
            await push_progress(req.task_id, 95, 'Finalizing results')
            await push_complete(req.task_id, {
                'questions': [item.model_dump() for item in results],
                'total_found': len(results),
                'rule_id': req.rule_id,
                'target_group_id': req.target_group_id,
                'new_group': req.new_group.model_dump() if req.new_group else None,
                'attempts': attempt,
            })
            return
        except CrawlerError as exc:
            last_error = exc
            logger.warning('Crawl {} attempt {}/{} failed: {}', req.task_id, attempt, attempts, exc)
            if attempt < attempts:
                await push_progress(req.task_id, min(90, attempt * 10), f'Retrying after {exc.stage} error')
                await asyncio.sleep(1)
                continue
            await push_error(req.task_id, {'code': exc.code, 'stage': exc.stage, 'message': str(exc), 'attempts': attempt})
            return
        except Exception as exc:
            last_error = exc
            logger.warning('Crawl {} attempt {}/{} failed: {}', req.task_id, attempt, attempts, exc)
            if attempt < attempts:
                await push_progress(req.task_id, min(90, attempt * 10), 'Retrying after unknown error')
                await asyncio.sleep(1)
                continue
            await push_error(req.task_id, {'code': 'CRAWLER_ERROR', 'stage': 'unknown', 'message': str(exc), 'attempts': attempt})
            return

    if last_error:
        await push_error(req.task_id, {'code': 'CRAWLER_ERROR', 'stage': 'unknown', 'message': str(last_error)})


async def _do_crawl_legacy(req: RunCrawlRequest) -> None:
    try:
        await push_progress(req.task_id, 0, 'Starting crawler')
        results = await crawl(req.rule, RuntimeContext(
            task_id=req.task_id,
            rule_id=req.rule_id,
            target_group_id=req.target_group_id,
            account_alias=req.account_alias,
            session_state=req.session_state,
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
