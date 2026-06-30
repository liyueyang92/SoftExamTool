import asyncio
import hashlib
import re
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException
from loguru import logger
from pydantic import BaseModel

from modules.progress import push_progress, push_complete, push_error

router = APIRouter(prefix='/pdf', tags=['pdf'])

# Knowledge tag keyword dictionary
KNOWLEDGE_TAG_KEYWORDS: dict[str, list[str]] = {
    '软件架构设计': ['架构', '分层', 'MVC', 'SOA', '微服务', '架构风格', '架构模式'],
    '质量属性': ['可用性', '性能', '安全', '可修改性', '可测试性', '质量属性', 'QA', '响应时间'],
    '软件设计': ['设计模式', 'UML', '类图', '时序图', '面向对象', '耦合', '内聚', 'SOLID'],
    '数据库': ['数据库', 'SQL', '事务', '索引', 'ER图', '关系模型', 'NoSQL', 'MongoDB', 'Redis'],
    '系统集成': ['集成', 'ESB', '消息队列', 'MQ', 'EAI', 'WebService', 'API', 'REST', 'SOAP'],
    '项目管理': ['项目管理', '进度', '成本', '风险', '敏捷', 'Scrum', '甘特图', 'WBS', 'PMBOK'],
    '信息安全': ['加密', '认证', '防火墙', 'PKI', 'SSL', 'TLS', 'XSS', 'SQL注入', '安全'],
    '嵌入式系统': ['嵌入式', '实时系统', 'RTOS', '单片机', '驱动程序', '中断'],
    '网络与通信': ['网络', 'TCP', 'UDP', 'HTTP', 'OSI', '协议', '路由', '交换机'],
    '论文写作': ['摘要', '论文', '项目背景', '技术难点', '解决方案', '总结'],
}


def classify_knowledge_tags(text: str) -> list[str]:
    tags = []
    text_lower = text.lower()
    for tag, keywords in KNOWLEDGE_TAG_KEYWORDS.items():
        if any(kw.lower() in text_lower for kw in keywords):
            tags.append(tag)
    return tags[:3]  # Return at most 3 tags


def chunk_text(text: str, page_num: int, doc_id: str, min_length: int = 50) -> list[dict]:
    chunks = []
    # Split by paragraphs (double newline or section headers)
    paragraphs = re.split(r'\n{2,}|(?=第[一二三四五六七八九十\d]+[章节])', text)
    for para in paragraphs:
        para = para.strip()
        if len(para) < min_length:
            continue
        tags = classify_knowledge_tags(para)
        chunks.append({
            'doc_id': doc_id,
            'page_num': page_num,
            'content': para[:2000],  # cap chunk size
            'knowledge_tags': tags,
        })
    # If no paragraphs found and text is long enough, use whole page
    if not chunks and len(text.strip()) >= min_length:
        chunks.append({
            'doc_id': doc_id,
            'page_num': page_num,
            'content': text.strip()[:2000],
            'knowledge_tags': classify_knowledge_tags(text),
        })
    return chunks


async def process_pdf(file_path: str, doc_id: str, task_id: str) -> None:
    try:
        import pdfplumber
    except ImportError:
        await push_error(task_id, 'pdfplumber 未安装，请运行 pip install pdfplumber')
        return

    logger.info('Starting PDF parse: {} (doc={}, task={})', file_path, doc_id, task_id)
    path = Path(file_path)
    if not path.exists():
        await push_error(task_id, f'文件不存在: {file_path}')
        return

    try:
        all_chunks: list[dict] = []
        page_count = 0

        with pdfplumber.open(str(path)) as pdf:
            page_count = len(pdf.pages)
            for i, page in enumerate(pdf.pages):
                text = page.extract_text() or ''
                if len(text.strip()) < 50:
                    # Sparse page — mark as potential scan, skip for now
                    logger.debug('Page {} has sparse text ({} chars), skipping OCR in Phase 3', i + 1, len(text))
                else:
                    chunks = chunk_text(text, i + 1, doc_id)
                    all_chunks.extend(chunks)

                # Push progress every 5 pages
                if (i + 1) % 5 == 0 or i + 1 == page_count:
                    progress = int((i + 1) / page_count * 90)
                    await push_progress(task_id, progress, f'正在解析第 {i + 1}/{page_count} 页')
                    await asyncio.sleep(0)  # yield to event loop

        await push_progress(task_id, 95, f'解析完成，共 {len(all_chunks)} 个文本块')
        await asyncio.sleep(0.1)

        await push_complete(task_id, {
            'doc_id': doc_id,
            'page_count': page_count,
            'chunks': all_chunks,
        })
        logger.info('PDF parse done: {} chunks for doc {}', len(all_chunks), doc_id)

    except Exception as e:
        logger.exception('PDF parse failed for {}', file_path)
        await push_error(task_id, str(e))


class ParseRequest(BaseModel):
    file_path: str
    doc_id: str
    task_id: str


class CheckCacheRequest(BaseModel):
    file_path: str


@router.post('/parse')
async def parse_pdf(req: ParseRequest, background_tasks: BackgroundTasks):
    background_tasks.add_task(process_pdf, req.file_path, req.doc_id, req.task_id)
    return {'status': 'started', 'task_id': req.task_id}


@router.post('/md5')
async def get_md5(req: CheckCacheRequest):
    path = Path(req.file_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail='File not found')
    h = hashlib.md5()
    with open(str(path), 'rb') as f:
        for chunk in iter(lambda: f.read(8192), b''):
            h.update(chunk)
    return {'md5': h.hexdigest()}
