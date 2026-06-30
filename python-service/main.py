import uvicorn
from fastapi import FastAPI
from loguru import logger
from config import settings
from middleware.auth import TokenAuthMiddleware
from modules.progress import router as progress_router
from modules.pdf.router import router as pdf_router
from modules.ai.router import router as ai_router
from modules.crawler.router import router as crawler_router

app = FastAPI(docs_url=None, redoc_url=None)
app.add_middleware(TokenAuthMiddleware)
app.include_router(progress_router)
app.include_router(pdf_router)
app.include_router(ai_router)
app.include_router(crawler_router)


@app.get('/health')
async def health():
    return {'status': 'ok', 'version': '0.3.0'}


@app.get('/ping')
async def ping():
    return {'message': 'pong'}


if __name__ == '__main__':
    logger.info('Starting Python service on port {}', settings.port)
    uvicorn.run(app, host='127.0.0.1', port=settings.port, log_level='info')
