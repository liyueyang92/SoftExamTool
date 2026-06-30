from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from config import settings


class TokenAuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.url.path == '/health':
            return await call_next(request)
        token = request.headers.get('x-internal-token', '')
        if not settings.internal_token or token != settings.internal_token:
            return JSONResponse(status_code=403, content={'detail': 'Forbidden'})
        return await call_next(request)
