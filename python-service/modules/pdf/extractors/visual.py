"""图示检测与视觉摘要生成。"""

from typing import Optional

from loguru import logger


# ── Prompt 模板 ────────────────────────────────────────────────────────────

FIGURE_SUMMARY_PROMPT = """你是软考系统架构设计师考试辅导专家。请仔细分析这张图片。

如果图片是流程图、架构图、UML图、关系图等结构化图形，请描述：
1. 图的主题（一句话概括）
2. 图中包含的主要元素/节点/角色
3. 元素之间的方向、层级或依赖关系
4. 对软考知识点的简短归类

如果图片是普通截图、照片或文本页面，请简要描述图片内容。

要求：
- 用简洁的中文，控制在 200 字以内
- 不确定的内容标注"图中未明确"
- 不要猜测图中没有的内容"""

TABLE_VISION_PROMPT = """请将这张图片中的表格转换为 Markdown 表格格式。
如果图片中不包含表格，请回复"图中无表格"。
要求：保持行列结构，空单元格保留为空，不要猜测内容。"""


# ── 图示检测 ───────────────────────────────────────────────────────────────


def detect_figure_page(page_text: str) -> bool:
    """
    规则检测：判断页面是否疑似包含图示/流程图。

    检测条件：
    - 文本量较少但页面有实质内容
    - OCR 到多个短标签（节点名称）
    """
    text_len = len(page_text.replace("\n", "").replace(" ", ""))
    if text_len == 0:
        return True  # 纯图片页

    lines = [line.strip() for line in page_text.split("\n") if line.strip()]
    if not lines:
        return False

    # 短文本行比例高 → 可能包含图示标签
    short_lines = [line for line in lines if len(line) < 20]
    if len(short_lines) / len(lines) > 0.7:
        return True

    return False


def detect_has_images(page) -> bool:
    """检测 pdfplumber 页面是否包含嵌入图片。"""
    try:
        images = getattr(page, "images", None)
        if images is not None and len(images) > 0:
            return True
    except Exception:
        pass
    return False


# ── 视觉摘要生成 ───────────────────────────────────────────────────────────


def generate_figure_summary_sync(
    vision_provider,
    image_path: str,
    cache_dir: str,
    model_name: str,
) -> Optional[dict]:
    """
    同步调用视觉模型生成图片摘要，返回结构化结果。

    返回 None 表示失败 / 跳过。
    返回 dict 包含 content, confidence, source_engine。
    """
    from modules.pdf.vision import _cache_key, _load_cached_summary, _save_cached_summary

    if vision_provider is None:
        logger.warning("Vision provider is None, skipping summary for {}", image_path)
        return None

    cache_key = _cache_key(image_path, FIGURE_SUMMARY_PROMPT, model_name)
    cached = _load_cached_summary(cache_dir, cache_key)
    if cached:
        logger.info("Vision summary cache hit for {}", image_path)
        return {
            "content": cached,
            "confidence": 0.75,
            "source_engine": "vision-cached",
        }

    try:
        import asyncio

        loop = asyncio.get_event_loop()
        if loop.is_running():
            # In async context: create a task and wait
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor() as executor:
                future = executor.submit(
                    asyncio.run,
                    vision_provider.describe_image(image_path, FIGURE_SUMMARY_PROMPT, temperature=0.2),
                )
                summary = future.result(timeout=90)
        else:
            summary = loop.run_until_complete(
                vision_provider.describe_image(image_path, FIGURE_SUMMARY_PROMPT, temperature=0.2)
            )

        _save_cached_summary(cache_dir, cache_key, summary)
        return {
            "content": summary,
            "confidence": 0.6,
            "source_engine": "vision-remote",
        }
    except Exception as exc:
        logger.warning("Vision summary failed for {}: {}", image_path, exc)
        return None


def build_figure_chunk_content(summary_text: str, page_num: int, figure_index: int) -> str:
    """用视觉摘要文本构建符合规范的 chunk content。"""
    title = f"## 第 {page_num} 页 图示摘要：图 {figure_index}\n\n"
    return title + summary_text.strip()
