import asyncio
import hashlib
import re
from collections import Counter
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException
from loguru import logger
from pydantic import BaseModel, Field, model_validator

from modules.pdf.extractors.assets import generate_page_screenshot, generate_table_crop
from modules.pdf.extractors.tables import extract_tables_from_page
from modules.pdf.extractors.visual import (
    detect_figure_page,
    generate_figure_summary_sync,
    build_figure_chunk_content,
)
from modules.pdf.vision import build_vision_provider
from modules.progress import push_complete, push_error, push_progress

router = APIRouter(prefix="/pdf", tags=["pdf"])

DEFAULT_TOP_MARGIN_RATIO = 0.07
DEFAULT_BOTTOM_MARGIN_RATIO = 0.07
CID_PATTERN = re.compile(r"\(cid:\d+\)")
SPARSE_TEXT_MIN_CHARS = 50
OCR_RENDER_SCALE = 2.5
OCR_MIN_CONFIDENCE = 0.4
OCR_LINE_Y_TOLERANCE_RATIO = 0.65
OCR_ENGINE = None
OCR_NUMBER_TOKEN_PATTERN = re.compile(r"^\d{1,4}$")

KNOWLEDGE_TAG_KEYWORDS: dict[str, list[str]] = {
    "软件架构设计": ["架构", "分层", "mvc", "soa", "微服务", "架构风格", "架构模式"],
    "质量属性": ["可用性", "性能", "安全", "可修改性", "可测试性", "质量属性", "qa", "响应时间"],
    "软件设计": ["设计模式", "uml", "类图", "时序图", "面向对象", "耦合", "内聚", "solid"],
    "数据库": ["数据库", "sql", "事务", "索引", "er图", "关系模型", "nosql", "mongodb", "redis"],
    "系统集成": ["集成", "esb", "消息队列", "mq", "eai", "webservice", "api", "rest", "soap"],
    "项目管理": ["项目管理", "进度", "成本", "风险", "敏捷", "scrum", "甘特图", "wbs", "pmbok"],
    "信息安全": ["加密", "认证", "防火墙", "pki", "ssl", "tls", "xss", "sql注入", "安全"],
    "嵌入式系统": ["嵌入式", "实时系统", "rtos", "单片机", "驱动程序", "中断"],
    "网络与通信": ["网络", "tcp", "udp", "http", "osi", "协议", "路由", "交换机"],
    "论文写作": ["摘要", "论文", "项目背景", "技术难点", "解决方案", "总结"],
}


def classify_knowledge_tags(text: str) -> list[str]:
    tags: list[str] = []
    text_lower = text.lower()
    for tag, keywords in KNOWLEDGE_TAG_KEYWORDS.items():
        if any(keyword in text_lower for keyword in keywords):
            tags.append(tag)
    return tags[:3]


def chunk_text(text: str, page_num: int, doc_id: str, min_length: int = 50) -> list[dict]:
    chunks: list[dict] = []
    paragraphs = re.split(r"\n{2,}|(?=第[一二三四五六七八九十\d]+[章节])", text)
    for paragraph in paragraphs:
        paragraph = paragraph.strip()
        if len(paragraph) < min_length:
            continue
        chunks.append(
            {
                "doc_id": doc_id,
                "page_num": page_num,
                "content": paragraph[:2000],
                "knowledge_tags": classify_knowledge_tags(paragraph),
                "chunk_type": "text",
                "source_engine": "",
                "confidence": None,
                "block_order": 0,
                "bbox": None,
            }
        )

    if not chunks and len(text.strip()) >= min_length:
        chunks.append(
            {
                "doc_id": doc_id,
                "page_num": page_num,
                "content": text.strip()[:2000],
                "knowledge_tags": classify_knowledge_tags(text),
                "chunk_type": "text",
                "source_engine": "",
                "confidence": None,
                "block_order": 0,
                "bbox": None,
            }
        )
    return chunks


def validate_margin_ratios(top_margin_ratio: float, bottom_margin_ratio: float) -> None:
    if top_margin_ratio < 0 or top_margin_ratio >= 1:
        raise ValueError("top_margin_ratio 必须在 [0, 1) 范围内")
    if bottom_margin_ratio < 0 or bottom_margin_ratio >= 1:
        raise ValueError("bottom_margin_ratio 必须在 [0, 1) 范围内")
    if top_margin_ratio + bottom_margin_ratio >= 1:
        raise ValueError("top_margin_ratio 与 bottom_margin_ratio 之和必须小于 1")


def normalize_page_range(page_count: int, start_page: int, end_page: Optional[int]) -> tuple[int, int]:
    if page_count <= 0:
        raise ValueError("PDF 没有可解析的页面")
    if start_page < 1:
        raise ValueError("start_page 必须大于等于 1")
    if start_page > page_count:
        raise ValueError(f"start_page 超出范围，当前 PDF 共 {page_count} 页")

    effective_end_page = page_count if end_page is None else end_page
    if effective_end_page < start_page:
        raise ValueError("end_page 不能小于 start_page")
    if effective_end_page > page_count:
        raise ValueError(f"end_page 超出范围，当前 PDF 共 {page_count} 页")

    return start_page, effective_end_page


def normalize_extracted_text(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n").strip()


def count_meaningful_chars(text: str) -> int:
    cleaned = re.sub(r"\s+", "", text)
    for boilerplate in ("内部资料，禁止传播", "内部资料,禁止传播"):
        cleaned = cleaned.replace(boilerplate, "")
    return len(cleaned)


def has_sparse_text(text: str) -> bool:
    return count_meaningful_chars(text) < SPARSE_TEXT_MIN_CHARS


def looks_like_cid_garble(text: str) -> bool:
    if not text:
        return False
    matches = CID_PATTERN.findall(text)
    if len(matches) < 3:
        return False
    cid_chars = sum(len(match) for match in matches)
    residual = CID_PATTERN.sub("", text).strip()
    return not residual or cid_chars / max(len(text), 1) > 0.25


def crop_pdfplumber_page(page, top_margin_ratio: float, bottom_margin_ratio: float):
    if top_margin_ratio == 0 and bottom_margin_ratio == 0:
        return page

    x0, top, x1, bottom = page.bbox
    page_height = bottom - top
    crop_top = top + page_height * top_margin_ratio
    crop_bottom = bottom - page_height * bottom_margin_ratio
    return page.crop((x0, crop_top, x1, crop_bottom))


def extract_text_with_pdfplumber(page, top_margin_ratio: float, bottom_margin_ratio: float) -> str:
    cropped_page = crop_pdfplumber_page(page, top_margin_ratio, bottom_margin_ratio)
    return normalize_extracted_text(cropped_page.extract_text() or "")


def extract_text_with_pdfium(page, top_margin_ratio: float, bottom_margin_ratio: float) -> str:
    textpage = page.get_textpage()
    try:
        left, bottom, right, top = page.get_bbox()
        page_height = top - bottom
        crop_bottom = bottom + page_height * bottom_margin_ratio
        crop_top = top - page_height * top_margin_ratio
        return normalize_extracted_text(
            textpage.get_text_bounded(left=left, bottom=crop_bottom, right=right, top=crop_top)
        )
    finally:
        textpage.close()


def get_ocr_engine():
    global OCR_ENGINE
    if OCR_ENGINE is not None:
        return OCR_ENGINE

    try:
        from rapidocr_onnxruntime import RapidOCR
    except ImportError as exc:
        raise RuntimeError("rapidocr-onnxruntime 未安装，无法识别扫描版 PDF") from exc

    OCR_ENGINE = RapidOCR()
    return OCR_ENGINE


def get_row_leading_number(row: list[dict[str, float | str]]) -> int | None:
    if len(row) < 2:
        return None

    row_words = sorted(row, key=lambda entry: float(entry["x0"]))
    first_text = str(row_words[0]["text"]).strip()
    if not OCR_NUMBER_TOKEN_PATTERN.fullmatch(first_text):
        return None

    return int(first_text)


def infer_missing_number_prefixes(rows: list[list[dict[str, float | str]]]) -> dict[int, int]:
    anchors: list[tuple[int, int]] = []
    for row_index, row in enumerate(rows):
        leading_number = get_row_leading_number(row)
        if leading_number is not None:
            anchors.append((row_index, leading_number))

    if len(anchors) < 3:
        return {}

    start_candidates = [row_index - number + 1 for row_index, number in anchors]
    start_index, support = Counter(start_candidates).most_common(1)[0]
    if support < max(3, len(anchors) // 2):
        return {}

    first_anchor_index = min(row_index for row_index, _ in anchors)
    last_anchor_index = max(row_index for row_index, _ in anchors)
    if start_index < 0 or start_index > first_anchor_index:
        return {}

    prefixes: dict[int, int] = {}
    for row_index in range(start_index, last_anchor_index + 1):
        expected_number = row_index - start_index + 1
        if expected_number < 1:
            continue
        if get_row_leading_number(rows[row_index]) is None:
            prefixes[row_index] = expected_number

    return prefixes


def extract_text_with_ocr(page, top_margin_ratio: float, bottom_margin_ratio: float) -> str:
    try:
        import numpy as np
    except ImportError as exc:
        raise RuntimeError("numpy 未安装，无法识别扫描版 PDF") from exc

    rendered = page.render(scale=OCR_RENDER_SCALE)
    image = rendered.to_pil().convert("RGB")
    width, height = image.size
    crop_top = int(height * top_margin_ratio)
    crop_bottom = int(height * (1 - bottom_margin_ratio))
    if crop_top > 0 or crop_bottom < height:
        image = image.crop((0, crop_top, width, crop_bottom))

    result, _ = get_ocr_engine()(np.array(image))
    words: list[dict[str, float | str]] = []
    for item in result or []:
        if len(item) < 3:
            continue
        text = str(item[1]).strip()
        try:
            score = float(item[2])
        except (TypeError, ValueError):
            score = 0.0
        if text and score >= OCR_MIN_CONFIDENCE:
            try:
                points = item[0]
                xs = [float(point[0]) for point in points]
                ys = [float(point[1]) for point in points]
            except (TypeError, ValueError, IndexError):
                continue

            words.append(
                {
                    "text": text,
                    "x0": min(xs),
                    "x1": max(xs),
                    "y_mid": sum(ys) / len(ys),
                    "height": max(ys) - min(ys),
                }
            )

    if not words:
        return ""

    rows: list[list[dict[str, float | str]]] = []
    for word in sorted(words, key=lambda entry: (float(entry["y_mid"]), float(entry["x0"]))):
        if not rows:
            rows.append([word])
            continue

        current_row = rows[-1]
        row_y_mid = sum(float(entry["y_mid"]) for entry in current_row) / len(current_row)
        row_height = max(float(entry["height"]) for entry in current_row)
        tolerance = max(row_height, float(word["height"]), 1.0) * OCR_LINE_Y_TOLERANCE_RATIO
        if abs(float(word["y_mid"]) - row_y_mid) <= tolerance:
            current_row.append(word)
        else:
            rows.append([word])

    inferred_number_prefixes = infer_missing_number_prefixes(rows)
    lines = []
    for row_index, row in enumerate(rows):
        row_words = sorted(row, key=lambda entry: float(entry["x0"]))
        parts = [str(entry["text"]) for entry in row_words]
        if row_index in inferred_number_prefixes:
            parts.insert(0, str(inferred_number_prefixes[row_index]))
        line = " ".join(parts)
        lines.append(re.sub(r"\s+", " ", line).strip())

    return normalize_extracted_text("\n".join(lines))


def get_extractor_backends():
    try:
        import pdfplumber
    except ImportError as exc:
        raise RuntimeError("pdfplumber 未安装，请运行 pip install pdfplumber") from exc

    try:
        import pypdfium2
    except ImportError:
        pypdfium2 = None

    return pdfplumber, pypdfium2


def extract_page_text(plumber_page, pdfium_page, top_margin_ratio: float, bottom_margin_ratio: float) -> tuple[str, str]:
    plumber_text = extract_text_with_pdfplumber(plumber_page, top_margin_ratio, bottom_margin_ratio)
    text = plumber_text
    engine = "pdfplumber"

    if looks_like_cid_garble(plumber_text) and pdfium_page is not None:
        try:
            pdfium_text = extract_text_with_pdfium(pdfium_page, top_margin_ratio, bottom_margin_ratio)
            if pdfium_text and not looks_like_cid_garble(pdfium_text):
                logger.info("CID-like text detected, fallback to pypdfium2 succeeded")
                text = pdfium_text
                engine = "pypdfium2"
            elif pdfium_text and len(pdfium_text) > len(plumber_text):
                logger.info("CID-like text detected, fallback to longer pypdfium2 result")
                text = pdfium_text
                engine = "pypdfium2"
        except Exception as exc:
            logger.warning("pypdfium2 fallback failed: {}", exc)

    if has_sparse_text(text) and pdfium_page is not None:
        try:
            ocr_text = extract_text_with_ocr(pdfium_page, top_margin_ratio, bottom_margin_ratio)
            if count_meaningful_chars(ocr_text) > count_meaningful_chars(text):
                logger.info(
                    "Sparse PDF text detected ({} chars), fallback to OCR produced {} chars",
                    count_meaningful_chars(text),
                    count_meaningful_chars(ocr_text),
                )
                return ocr_text, "rapidocr"
        except Exception as exc:
            logger.warning("OCR fallback failed: {}", exc)

    return text, engine


def parse_pdf_pages(
    file_path: str,
    doc_id: str,
    top_margin_ratio: float = DEFAULT_TOP_MARGIN_RATIO,
    bottom_margin_ratio: float = DEFAULT_BOTTOM_MARGIN_RATIO,
    start_page: int = 1,
    end_page: Optional[int] = None,
    extract_tables: bool = True,
    save_page_images: bool = True,
    output_dir: str = "",
    generate_visual_summary: bool = False,
    vision_mode: str = "disabled",
    ai_config: Optional[dict] = None,
) -> dict:
    pdfplumber, pypdfium2 = get_extractor_backends()
    validate_margin_ratios(top_margin_ratio, bottom_margin_ratio)

    resolved_output_dir = output_dir or str(Path(file_path).parent)
    vision_cache_dir = str(Path(resolved_output_dir) / "vision_cache")

    # 构建视觉模型提供者（如需要）
    vision_provider = None
    vision_model_name = "unknown"
    if generate_visual_summary and vision_mode != "disabled" and ai_config:
        try:
            ai_cfg = dict(ai_config)
            ai_cfg["mode"] = {"remote": ai_cfg.get("mode", "openai"), "local": "ollama"}.get(
                vision_mode, ai_cfg.get("mode", "openai")
            )
            vision_provider = build_vision_provider(ai_cfg)
            if vision_provider:
                vision_model_name = getattr(vision_provider, "model", "unknown")
                logger.info("Vision provider built: mode={}", vision_mode)
        except Exception as exc:
            logger.warning("Failed to build vision provider: {}", exc)
            vision_provider = None

    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"文件不存在: {file_path}")

    all_chunks: list[dict] = []
    assets: list[dict] = []
    warnings: list[dict] = []
    engines_used: set[str] = set()
    pdfium_doc = None

    try:
        if pypdfium2 is not None:
            pdfium_doc = pypdfium2.PdfDocument(str(path))

        with pdfplumber.open(str(path)) as pdf:
            page_count = len(pdf.pages)
            effective_start_page, effective_end_page = normalize_page_range(page_count, start_page, end_page)
            selected_pages = range(effective_start_page - 1, effective_end_page)

            for page_index in selected_pages:
                page_num = page_index + 1
                pdfium_page = pdfium_doc.get_page(page_index) if pdfium_doc is not None else None
                try:
                    text, engine = extract_page_text(
                        pdf.pages[page_index],
                        pdfium_page,
                        top_margin_ratio,
                        bottom_margin_ratio,
                    )

                    # 表格提取
                    table_blocks = []
                    if extract_tables:
                        table_blocks = extract_tables_from_page(pdf.pages[page_index], page_num)
                        engines_used.add("table-extractor")

                    # 页面截图资产
                    page_asset_id: Optional[str] = None
                    page_image_path: Optional[str] = None
                    if save_page_images and pdfium_page is not None:
                        page_asset = generate_page_screenshot(
                            pdfium_page, page_num, doc_id, resolved_output_dir
                        )
                        if page_asset:
                            assets.append(page_asset)
                            page_asset_id = page_asset["id"]
                            page_image_path = page_asset["file_path"]

                    # 表格裁剪资产
                    for tb in table_blocks:
                        table_asset_id: Optional[str] = None
                        if save_page_images and pdfium_page is not None and tb.get("asset_bbox"):
                            table_asset = generate_table_crop(
                                pdfium_page, page_num, doc_id,
                                resolved_output_dir, tb["asset_bbox"],
                            )
                            if table_asset:
                                assets.append(table_asset)
                                table_asset_id = table_asset["id"]

                        all_chunks.append({
                            "doc_id": doc_id,
                            "page_num": page_num,
                            "content": tb["content"],
                            "knowledge_tags": classify_knowledge_tags(tb["content"]),
                            "chunk_type": tb["chunk_type"],
                            "asset_id": table_asset_id,
                            "source_engine": tb["source_engine"],
                            "confidence": tb["confidence"],
                            "block_order": tb["block_order"],
                            "bbox": tb["bbox"],
                        })

                    # 视觉摘要
                    if generate_visual_summary and vision_provider is not None:
                        is_figure = detect_figure_page(text)
                        if is_figure and page_image_path:
                            logger.info("Generating vision summary for page {}", page_num)
                            engines_used.add("vision-model")
                            figure_result = generate_figure_summary_sync(
                                vision_provider, page_image_path,
                                vision_cache_dir, vision_model_name,
                            )
                            if figure_result:
                                figure_content = build_figure_chunk_content(
                                    figure_result["content"], page_num, 1
                                )
                                all_chunks.append({
                                    "doc_id": doc_id,
                                    "page_num": page_num,
                                    "content": figure_content[:2000],
                                    "knowledge_tags": classify_knowledge_tags(figure_result["content"]),
                                    "chunk_type": "figure",
                                    "asset_id": page_asset_id,
                                    "source_engine": figure_result["source_engine"],
                                    "confidence": figure_result["confidence"],
                                    "block_order": 2,
                                    "bbox": "{}",
                                })
                            else:
                                logger.warning("Vision summary returned None for page {}", page_num)
                        elif is_figure and not page_image_path:
                            warnings.append({
                                "page_num": page_num,
                                "code": "PDF_ASSET_SAVE_FAILED",
                                "message": "检测到疑似图示但页面截图不可用，无法生成视觉摘要。",
                            })
                finally:
                    if pdfium_page is not None:
                        pdfium_page.close()

                engines_used.add(engine)
                if not has_sparse_text(text):
                    text_chunks = chunk_text(text, page_num, doc_id)
                    for tc in text_chunks:
                        if page_asset_id:
                            tc["asset_id"] = page_asset_id
                    all_chunks.extend(text_chunks)

        return {
            "doc_id": doc_id,
            "page_count": page_count,
            "parsed_page_count": effective_end_page - effective_start_page + 1,
            "parsed_range": {"start_page": effective_start_page, "end_page": effective_end_page},
            "crop_ratios": {
                "top_margin_ratio": top_margin_ratio,
                "bottom_margin_ratio": bottom_margin_ratio,
            },
            "engines_used": sorted(engines_used),
            "chunks": all_chunks,
            "assets": assets,
            "warnings": warnings,
        }
    finally:
        if pdfium_doc is not None:
            pdfium_doc.close()


def preview_pdf_page(
    file_path: str,
    preview_page: int,
    top_margin_ratio: float = DEFAULT_TOP_MARGIN_RATIO,
    bottom_margin_ratio: float = DEFAULT_BOTTOM_MARGIN_RATIO,
) -> dict:
    pdfplumber, pypdfium2 = get_extractor_backends()
    validate_margin_ratios(top_margin_ratio, bottom_margin_ratio)

    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"文件不存在: {file_path}")
    if preview_page < 1:
        raise ValueError("preview_page 必须大于等于 1")

    pdfium_doc = None
    try:
        if pypdfium2 is not None:
            pdfium_doc = pypdfium2.PdfDocument(str(path))

        with pdfplumber.open(str(path)) as pdf:
            page_count = len(pdf.pages)
            if preview_page > page_count:
                raise ValueError(f"preview_page 超出范围，当前 PDF 共 {page_count} 页")

            page = pdf.pages[preview_page - 1]
            pdfium_page = pdfium_doc.get_page(preview_page - 1) if pdfium_doc is not None else None
            try:
                text, engine = extract_page_text(page, pdfium_page, top_margin_ratio, bottom_margin_ratio)
            finally:
                if pdfium_page is not None:
                    pdfium_page.close()

            x0, top, x1, bottom = page.bbox
            page_height = bottom - top
            crop_top = top + page_height * top_margin_ratio
            crop_bottom = bottom - page_height * bottom_margin_ratio

            # 表格检测
            detected_tables_count = 0
            try:
                found_tables = page.find_tables()
                detected_tables_count = len(found_tables or [])
            except Exception:
                pass

            # 图示检测
            is_figure_page = detect_figure_page(text)
            detected_figures_count = 1 if is_figure_page else 0

        return {
            "page_count": page_count,
            "preview_page": preview_page,
            "crop_ratios": {
                "top_margin_ratio": top_margin_ratio,
                "bottom_margin_ratio": bottom_margin_ratio,
            },
            "crop_bbox": {
                "x0": x0,
                "top": crop_top,
                "x1": x1,
                "bottom": crop_bottom,
            },
            "engine": engine,
            "text": text,
            "detected_tables_count": detected_tables_count,
            "detected_figures_count": detected_figures_count,
        }
    finally:
        if pdfium_doc is not None:
            pdfium_doc.close()


async def process_pdf(
    file_path: str,
    doc_id: str,
    task_id: str,
    top_margin_ratio: float = DEFAULT_TOP_MARGIN_RATIO,
    bottom_margin_ratio: float = DEFAULT_BOTTOM_MARGIN_RATIO,
    start_page: int = 1,
    end_page: Optional[int] = None,
    extract_tables: bool = True,
    save_page_images: bool = True,
    output_dir: str = "",
    generate_visual_summary: bool = False,
    vision_mode: str = "disabled",
    ai_config: Optional[dict] = None,
) -> None:
    logger.info(
        "Starting PDF parse: {} (doc={}, task={}, top={}, bottom={}, start={}, end={}, "
        "extract_tables={}, save_images={}, vision={})",
        file_path, doc_id, task_id, top_margin_ratio, bottom_margin_ratio,
        start_page, end_page, extract_tables, save_page_images, vision_mode,
    )

    try:
        result = parse_pdf_pages(
            file_path=file_path,
            doc_id=doc_id,
            top_margin_ratio=top_margin_ratio,
            bottom_margin_ratio=bottom_margin_ratio,
            start_page=start_page,
            end_page=end_page,
            extract_tables=extract_tables,
            save_page_images=save_page_images,
            output_dir=output_dir,
            generate_visual_summary=generate_visual_summary,
            vision_mode=vision_mode,
            ai_config=ai_config,
        )

        page_count = int(result["page_count"])
        parsed_range = result["parsed_range"]
        selected_total = int(result["parsed_page_count"])
        chunks = result["chunks"]
        assets = result.get("assets", [])
        table_count = sum(1 for c in chunks if c.get("chunk_type") == "table")
        figure_count = sum(1 for c in chunks if c.get("chunk_type") == "figure")
        warnings = result.get("warnings", [])
        await push_progress(
            task_id,
            95,
            f"解析完成，范围 {parsed_range['start_page']}~{parsed_range['end_page']}，"
            f"共 {len(chunks)} 个文本块，{table_count} 个表格，{figure_count} 个图示摘要，"
            f"{len(assets)} 个资产，{len(warnings)} 个警告",
        )
        await asyncio.sleep(0.1)
        await push_complete(task_id, result)
        logger.info(
            "PDF parse done: {} chunks ({} tables) for doc {} (page_count={}, selected={})",
            len(chunks),
            table_count,
            doc_id,
            page_count,
            selected_total,
        )
    except Exception as exc:
        logger.exception("PDF parse failed for {}", file_path)
        await push_error(task_id, str(exc))


class PdfExtractOptions(BaseModel):
    top_margin_ratio: float = Field(default=DEFAULT_TOP_MARGIN_RATIO)
    bottom_margin_ratio: float = Field(default=DEFAULT_BOTTOM_MARGIN_RATIO)
    start_page: int = Field(default=1)
    end_page: Optional[int] = Field(default=None)

    @model_validator(mode="after")
    def validate_options(self):
        validate_margin_ratios(self.top_margin_ratio, self.bottom_margin_ratio)
        if self.start_page < 1:
            raise ValueError("start_page 必须大于等于 1")
        if self.end_page is not None and self.end_page < self.start_page:
            raise ValueError("end_page 不能小于 start_page")
        return self


class ParseRequest(PdfExtractOptions):
    file_path: str
    doc_id: str
    task_id: str
    extract_tables: bool = True
    save_page_images: bool = True
    output_dir: str = ""
    generate_visual_summary: bool = False
    vision_mode: str = "disabled"
    ai_config: Optional[dict] = None


class PreviewRequest(PdfExtractOptions):
    file_path: str
    preview_page: int = Field(default=1)

    @model_validator(mode="after")
    def validate_preview_page(self):
        if self.preview_page < 1:
            raise ValueError("preview_page 必须大于等于 1")
        return self


class CheckCacheRequest(BaseModel):
    file_path: str


class ReparsePageRequest(BaseModel):
    file_path: str
    doc_id: str
    page_num: int = Field(ge=1)
    top_margin_ratio: float = Field(default=DEFAULT_TOP_MARGIN_RATIO)
    bottom_margin_ratio: float = Field(default=DEFAULT_BOTTOM_MARGIN_RATIO)
    re_ocr: bool = False
    re_tables: bool = True
    re_vision: bool = False
    save_page_images: bool = True
    output_dir: str = ""
    vision_mode: str = "disabled"
    ai_config: Optional[dict] = None


@router.post("/reparse-page")
async def reparse_page(req: ReparsePageRequest):
    """单页重新解析，支持 OCR / 表格 / 视觉摘要。"""
    try:
        result = parse_pdf_pages(
            file_path=req.file_path,
            doc_id=req.doc_id,
            top_margin_ratio=req.top_margin_ratio,
            bottom_margin_ratio=req.bottom_margin_ratio,
            start_page=req.page_num,
            end_page=req.page_num,
            extract_tables=req.re_tables,
            save_page_images=req.save_page_images,
            output_dir=req.output_dir,
            generate_visual_summary=req.re_vision and req.vision_mode != "disabled",
            vision_mode=req.vision_mode,
            ai_config=req.ai_config,
        )
        return {
            "doc_id": result["doc_id"],
            "page_num": req.page_num,
            "chunks": result["chunks"],
            "assets": result["assets"],
            "engines_used": result["engines_used"],
            "warnings": result.get("warnings", []),
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Reparse page {} failed", req.page_num)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/parse")
async def parse_pdf(req: ParseRequest, background_tasks: BackgroundTasks):
    background_tasks.add_task(
        process_pdf,
        req.file_path,
        req.doc_id,
        req.task_id,
        req.top_margin_ratio,
        req.bottom_margin_ratio,
        req.start_page,
        req.end_page,
        req.extract_tables,
        req.save_page_images,
        req.output_dir,
        req.generate_visual_summary,
        req.vision_mode,
        req.ai_config,
    )
    return {"status": "started", "task_id": req.task_id}


@router.post("/preview")
async def preview_pdf(req: PreviewRequest):
    try:
        return preview_pdf_page(
            file_path=req.file_path,
            preview_page=req.preview_page,
            top_margin_ratio=req.top_margin_ratio,
            bottom_margin_ratio=req.bottom_margin_ratio,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/md5")
async def get_md5(req: CheckCacheRequest):
    path = Path(req.file_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="File not found")

    md5_hash = hashlib.md5()
    with open(str(path), "rb") as file_obj:
        for chunk in iter(lambda: file_obj.read(8192), b""):
            md5_hash.update(chunk)
    return {"md5": md5_hash.hexdigest()}
