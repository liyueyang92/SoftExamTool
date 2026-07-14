"""PDF 表格提取：使用 pdfplumber 检测表格并输出 Markdown。"""

import re
from typing import Optional

from loguru import logger


def extract_tables_from_page(page, page_num: int) -> list[dict]:
    """
    从单页 PDF 提取所有表格，返回结构化列表。
    每条结果包含：
      - page_num: int
      - chunk_type: 'table'
      - content: str (Markdown table)
      - bbox: dict
      - confidence: float
      - source_engine: 'pdfplumber-table'
      - block_order: int
      - asset_type: str
      - asset_bbox: dict
    """
    tables = []
    try:
        found = page.find_tables()
    except Exception as exc:
        logger.warning("Page {} table detection failed: {}", page_num, exc)
        return tables

    for idx, table in enumerate(found):
        try:
            raw = table.extract()
        except Exception as exc:
            logger.warning("Page {} table {} extraction failed: {}", page_num, idx, exc)
            continue

        if not raw or len(raw) < 2:
            continue

        # 清理单元格
        cleaned = _clean_table(raw)
        if not cleaned or len(cleaned) < 2:
            continue

        md = _to_markdown(cleaned, page_num, idx + 1)
        if not md:
            continue

        bbox = _table_bbox(table)
        tables.append({
            "page_num": page_num,
            "chunk_type": "table",
            "content": md,
            "bbox": bbox,
            "confidence": 0.85,
            "source_engine": "pdfplumber-table",
            "block_order": idx,
            "asset_type": "table_crop",
            "asset_bbox": bbox,
        })

    return tables


def _clean_table(raw: list[list[Optional[str]]]) -> list[list[str]]:
    """清洗表格单元格：去 None、去换行、合并多余空白。"""
    result = []
    for row in raw:
        cleaned_row = [
            re.sub(r"\s+", " ", (cell or "").replace("\n", " ")).strip()
            for cell in row
        ]
        if any(cleaned_row):
            result.append(cleaned_row)
    return result


def _to_markdown(rows: list[list[str]], page_num: int, table_index: int) -> str:
    """将二维数组转为 Markdown pipe 表格。"""
    if not rows:
        return ""

    # 生成标题
    header_cells = rows[0]
    title_text = "、".join(h for h in header_cells if h)[:30] or f"表格 {table_index}"
    title = f"## 第 {page_num} 页 表格：{title_text}\n\n"

    # 确定列数
    max_cols = max(len(row) for row in rows)
    if max_cols < 2:
        return ""  # 单列表格不转 Markdown 表格

    # 补齐列
    padded = []
    for row in rows:
        padded.append(row + [""] * (max_cols - len(row)))

    # 表头
    header = "| " + " | ".join(padded[0]) + " |\n"
    separator = "| " + " | ".join(["---"] * max_cols) + " |\n"

    # 数据行
    body = ""
    for row in padded[1:]:
        body += "| " + " | ".join(row) + " |\n"

    return title + header + separator + body


def _table_bbox(table) -> dict:
    """提取表格的边界框坐标。"""
    try:
        return {
            "x0": round(float(table.bbox[0]), 1),
            "top": round(float(table.bbox[1]), 1),
            "x1": round(float(table.bbox[2]), 1),
            "bottom": round(float(table.bbox[3]), 1),
        }
    except Exception:
        return {}
