from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query
from loguru import logger
from config import settings

router = APIRouter()

_connections: dict[str, WebSocket] = {}


@router.websocket('/ws/progress/{task_id}')
async def ws_progress(
    websocket: WebSocket,
    task_id: str,
    token: str = Query(default=''),
):
    if not settings.internal_token or token != settings.internal_token:
        await websocket.close(code=4003, reason='Unauthorized')
        logger.warning('WS unauthorized attempt for task {}', task_id)
        return

    await websocket.accept()
    _connections[task_id] = websocket
    logger.info('WS connected for task {}', task_id)

    try:
        while True:
            # Keep the connection alive; client sends pings, we echo them
            data = await websocket.receive_text()
            if data == 'ping':
                await websocket.send_text('pong')
    except WebSocketDisconnect:
        logger.info('WS disconnected for task {}', task_id)
    finally:
        _connections.pop(task_id, None)


async def push_progress(task_id: str, progress: int, message: str) -> bool:
    ws = _connections.get(task_id)
    if ws is None:
        return False
    try:
        await ws.send_json({'type': 'progress', 'taskId': task_id, 'progress': progress, 'message': message})
        return True
    except Exception as e:
        logger.warning('Failed to push progress to task {}: {}', task_id, e)
        _connections.pop(task_id, None)
        return False


async def push_complete(task_id: str, result: dict) -> bool:
    ws = _connections.get(task_id)
    if ws is None:
        return False
    try:
        await ws.send_json({'type': 'complete', 'taskId': task_id, 'result': result})
        return True
    except Exception as e:
        logger.warning('Failed to push complete to task {}: {}', task_id, e)
        _connections.pop(task_id, None)
        return False


async def push_error(task_id: str, error: str) -> bool:
    ws = _connections.get(task_id)
    if ws is None:
        return False
    try:
        await ws.send_json({'type': 'error', 'taskId': task_id, 'error': error})
        return True
    except Exception as e:
        logger.warning('Failed to push error to task {}: {}', task_id, e)
        _connections.pop(task_id, None)
        return False
