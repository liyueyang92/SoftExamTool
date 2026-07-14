"""PDF 页面/区域图片资产生成。"""

import hashlib
import uuid
from pathlib import Path
from typing import Optional

from loguru import logger


def generate_page_screenshot(
    pdfium_page,
    page_num: int,
    doc_id: str,
    output_dir: str,
    scale: float = 2.0,
) -> Optional[dict]:
    """
    生成页面截图并保存为 PNG，返回资产元数据。
    """
    try:
        from PIL import Image
    except ImportError:
        logger.warning("Pillow not installed, cannot generate page screenshots")
        return None

    try:
        bitmap = pdfium_page.render(scale=scale)
        image = bitmap.to_pil()
    except Exception as exc:
        logger.warning("Failed to render page {} screenshot: {}", page_num, exc)
        return None

    try:
        assets_dir = Path(output_dir) / doc_id / "assets"
        assets_dir.mkdir(parents=True, exist_ok=True)

        filename = f"page-{page_num:04d}.png"
        filepath = assets_dir / filename
        image.save(str(filepath), "PNG")

        content_hash = _hash_file(str(filepath))
        return {
            "id": str(uuid.uuid4()),
            "doc_id": doc_id,
            "page_num": page_num,
            "asset_type": "page_image",
            "file_path": str(filepath),
            "width": image.width,
            "height": image.height,
            "bbox": "{}",
            "content_hash": content_hash,
        }
    except Exception as exc:
        logger.warning("Failed to save page screenshot for page {}: {}", page_num, exc)
        return None


def generate_table_crop(
    pdfium_page,
    page_num: int,
    doc_id: str,
    output_dir: str,
    bbox: dict,
    scale: float = 2.0,
) -> Optional[dict]:
    """裁剪表格区域并保存为 PNG。"""
    try:
        from PIL import Image
    except ImportError:
        return None

    try:
        bitmap = pdfium_page.render(scale=scale)
        image = bitmap.to_pil()
    except Exception as exc:
        logger.warning("Failed to render page {} for table crop: {}", page_num, exc)
        return None

    try:
        x0 = int(bbox.get("x0", 0) * scale)
        top = int(bbox.get("top", 0) * scale)
        x1 = int(bbox.get("x1", image.width / scale) * scale)
        bottom = int(bbox.get("bottom", image.height / scale) * scale)

        # 边界保护
        x0 = max(0, x0)
        top = max(0, top)
        x1 = min(image.width, x1)
        bottom = min(image.height, bottom)

        if x1 <= x0 or bottom <= top:
            logger.warning("Invalid crop bbox for page {}: {}", page_num, bbox)
            return None

        cropped = image.crop((x0, top, x1, bottom))

        assets_dir = Path(output_dir) / doc_id / "assets"
        assets_dir.mkdir(parents=True, exist_ok=True)

        bbox_hash = _hash_bbox(bbox)
        filename = f"page-{page_num:04d}-table-{bbox_hash}.png"
        filepath = assets_dir / filename
        cropped.save(str(filepath), "PNG")

        content_hash = _hash_file(str(filepath))
        return {
            "id": str(uuid.uuid4()),
            "doc_id": doc_id,
            "page_num": page_num,
            "asset_type": "table_crop",
            "file_path": str(filepath),
            "width": cropped.width,
            "height": cropped.height,
            "bbox": str(bbox),
            "content_hash": content_hash,
        }
    except Exception as exc:
        logger.warning("Failed to generate table crop for page {}: {}", page_num, exc)
        return None


def generate_figure_crop(
    pdfium_page,
    page_num: int,
    doc_id: str,
    output_dir: str,
    bbox: dict,
    scale: float = 2.0,
) -> Optional[dict]:
    """裁剪图形区域并保存为 PNG（预留 Phase 3 使用）。"""
    try:
        from PIL import Image
    except ImportError:
        return None

    try:
        bitmap = pdfium_page.render(scale=scale)
        image = bitmap.to_pil()
    except Exception as exc:
        logger.warning("Failed to render page {} for figure crop: {}", page_num, exc)
        return None

    try:
        x0 = int(bbox.get("x0", 0) * scale)
        top = int(bbox.get("top", 0) * scale)
        x1 = int(bbox.get("x1", image.width / scale) * scale)
        bottom = int(bbox.get("bottom", image.height / scale) * scale)

        x0 = max(0, x0)
        top = max(0, top)
        x1 = min(image.width, x1)
        bottom = min(image.height, bottom)

        if x1 <= x0 or bottom <= top:
            return None

        cropped = image.crop((x0, top, x1, bottom))

        assets_dir = Path(output_dir) / doc_id / "assets"
        assets_dir.mkdir(parents=True, exist_ok=True)

        bbox_hash = _hash_bbox(bbox)
        filename = f"page-{page_num:04d}-figure-{bbox_hash}.png"
        filepath = assets_dir / filename
        cropped.save(str(filepath), "PNG")

        content_hash = _hash_file(str(filepath))
        return {
            "id": str(uuid.uuid4()),
            "doc_id": doc_id,
            "page_num": page_num,
            "asset_type": "figure_crop",
            "file_path": str(filepath),
            "width": cropped.width,
            "height": cropped.height,
            "bbox": str(bbox),
            "content_hash": content_hash,
        }
    except Exception as exc:
        logger.warning("Failed to generate figure crop for page {}: {}", page_num, exc)
        return None


def _hash_file(filepath: str) -> str:
    """计算文件的 SHA256。"""
    sha = hashlib.sha256()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            sha.update(chunk)
    return sha.hexdigest()


def _hash_bbox(bbox: dict) -> str:
    """为 bbox 生成短哈希用于文件名。"""
    return hashlib.md5(str(bbox).encode()).hexdigest()[:8]
