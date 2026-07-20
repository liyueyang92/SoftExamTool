"""Phase 0: 文档标签清洗模块。

提供批量清洗 doc_chunks 标签的能力：
  - 噪声页面检测与标记
  - 关键词分级重分类
  - 置信度重算
  - AI 重分类（低置信度正文 chunk）
  - 清洗报告生成
"""

from __future__ import annotations

from collections import Counter
from typing import Optional

from loguru import logger

from modules.pdf.router import (
    classify_knowledge_tags_v2,
    compute_chunk_confidence,
    is_noise_page,
)

# 置信度分级阈值
HIGH_CONFIDENCE = 0.70
MEDIUM_CONFIDENCE = 0.40
LOW_CONFIDENCE = 0.15


def clean_chunk(
    chunk: dict,
    total_pages: int,
    neighbor_tags: Optional[list[str]] = None,
) -> dict:
    """清洗单个 chunk 的标签和置信度。

    Args:
        chunk: 原始 chunk 数据（含 content, page_num, chunk_type, knowledge_tags 等）
        total_pages: 所属文档的总页数
        neighbor_tags: 相邻 chunk 的标签列表（用于邻居一致性评分）

    Returns:
        dict with keys: knowledge_tags, confidence, noise_type, action
    """
    page_num = chunk.get("page_num", 1)
    content = chunk.get("content", "")
    chunk_type = chunk.get("chunk_type", "text")
    old_tags = chunk.get("knowledge_tags", [])

    # 确保 old_tags 是列表
    if isinstance(old_tags, str):
        import json
        try:
            old_tags = json.loads(old_tags)
        except (json.JSONDecodeError, TypeError):
            old_tags = []

    # Step 1: 噪声页面检测
    is_noise, noise_type = is_noise_page(content, page_num, total_pages)

    # Step 2: 重新分类
    if is_noise:
        new_tags: list[str] = []
        tag_conf = 0.0
        action = "noise_cleared"
    else:
        new_tags, tag_conf = classify_knowledge_tags_v2(content)
        if not new_tags:
            action = "low_confidence_cleared"
        else:
            action = "reclassified"

    # Step 3: 置信度计算
    tag_confidences = {t: tag_conf for t in new_tags} if new_tags else {}
    confidence = compute_chunk_confidence(
        new_tags,
        tag_confidences,
        page_num,
        total_pages,
        content,
        chunk_type,
        noise_type,
        neighbor_tags,
    )

    return {
        "knowledge_tags": new_tags,
        "confidence": round(confidence, 4),
        "noise_type": noise_type,
        "action": action,
        "old_tags": old_tags,
    }


def clean_chunks_batch(
    chunks: list[dict],
    total_pages: int,
) -> list[dict]:
    """批量清洗 chunk 列表。

    清洗流程:
      1. 按 page_num 排序
      2. 逐个清洗，传递相邻标签用于邻居一致性评分
      3. 生成清洗报告

    Returns:
        清洗后的 chunk 列表，每项包含清洗结果
    """
    # 确保按页码排序
    sorted_chunks = sorted(chunks, key=lambda c: (c.get("page_num", 1), c.get("block_order", 0)))

    results: list[dict] = []

    for i, chunk in enumerate(sorted_chunks):
        # 提取邻居标签（前后各 2 个 chunk，取已清洗的）
        neighbor_tags: list[str] = []
        for offset in (-2, -1, 1, 2):
            ni = i + offset
            if 0 <= ni < len(sorted_chunks):
                neighbor = sorted_chunks[ni]
                n_tags = neighbor.get("knowledge_tags", [])
                if isinstance(n_tags, str):
                    import json
                    try:
                        n_tags = json.loads(n_tags)
                    except (json.JSONDecodeError, TypeError):
                        n_tags = []
                neighbor_tags.extend(n_tags)

        result = clean_chunk(chunk, total_pages, neighbor_tags)
        result["id"] = chunk.get("id")  # 保留原始 ID
        result["doc_id"] = chunk.get("doc_id")
        result["page_num"] = chunk.get("page_num")
        results.append(result)

    return results


def generate_cleaning_report(results: list[dict]) -> dict:
    """根据清洗结果生成汇总报告。

    Args:
        results: clean_chunks_batch 的返回结果

    Returns:
        清洗报告 JSON
    """
    total = len(results)
    action_counts = Counter(r.get("action", "unknown") for r in results)
    noise_type_counts = Counter(r.get("noise_type", "") for r in results if r.get("noise_type"))

    confidences = [r.get("confidence", 0.0) for r in results]
    conf_sorted = sorted(confidences)
    n = len(conf_sorted)
    mean_conf = sum(conf_sorted) / max(n, 1)
    median_conf = conf_sorted[n // 2] if n > 0 else 0.0
    p10 = conf_sorted[int(n * 0.10)] if n >= 10 else (conf_sorted[0] if n > 0 else 0.0)
    p90 = conf_sorted[int(n * 0.90)] if n >= 10 else (conf_sorted[-1] if n > 0 else 0.0)

    # 按置信度分级的统计
    high = sum(1 for c in confidences if c >= HIGH_CONFIDENCE)
    medium = sum(1 for c in confidences if MEDIUM_CONFIDENCE <= c < HIGH_CONFIDENCE)
    low = sum(1 for c in confidences if LOW_CONFIDENCE <= c < MEDIUM_CONFIDENCE)
    invalid = sum(1 for c in confidences if c < LOW_CONFIDENCE)

    noise_report = dict(noise_type_counts) if noise_type_counts else {}

    return {
        "total_chunks": total,
        "actions": dict(action_counts),
        "noise_cleared": noise_report,
        "confidence_levels": {
            "high": high,
            "medium": medium,
            "low": low,
            "invalid": invalid,
        },
        "confidence_stats": {
            "mean": round(mean_conf, 4),
            "median": round(median_conf, 4),
            "p10": round(p10, 4),
            "p90": round(p90, 4),
        },
        "needs_ai_reclassification": action_counts.get("low_confidence_cleared", 0),
    }


def get_chunks_needing_ai(results: list[dict]) -> list[dict]:
    """从清洗结果中提取需要 AI 重分类的 chunk。

    返回低置信度正文 chunk (非 noise，但分类结果为空)。
    """
    return [
        r for r in results
        if r.get("action") == "low_confidence_cleared"
    ]


# ─── Phase 4: Feedback loop ──────────────────────────────────────────────────


def discover_error_patterns(corrections: list[dict]) -> list[dict]:
    """从 tag_corrections 记录中自动发现常见错误模式。

    规则：
      1. 同类修正出现 ≥ 10 次 → 生成新的噪声检测规则
      2. 某关键词导致 ≥ 5 次错误标注 → 提示降低该关键词权重
      3. 同一知识点的 chunk 被反复修正 → 提示该知识点的关键词覆盖不足

    Args:
        corrections: tag_corrections 表记录列表
            [{old_tags, new_tags, action, pattern_tag}]

    Returns:
        [{type, suggestion, occurrence, detail}]
    """
    patterns = []

    # 按 noise_type 聚合
    noise_counts = Counter(
        c.get("pattern_tag", c.get("action", ""))
        for c in corrections
        if c.get("action") == "noise_cleared"
    )
    for noise_type, count in noise_counts.items():
        if count >= 10:
            patterns.append({
                "type": "auto_noise_rule",
                "detail": noise_type,
                "occurrence": count,
                "suggestion": f"该噪音模式出现了 {count} 次，建议加入 A1 噪声检测优化规则",
            })

    # 按修正前后的标签对聚合
    correction_pairs = Counter(
        (str(c.get("old_tags", "")), str(c.get("new_tags", "")))
        for c in corrections
        if c.get("action") in ("reclassified", "ai_corrected", "human_corrected")
    )
    for (old, new), count in correction_pairs.items():
        if count >= 5:
            patterns.append({
                "type": "keyword_weight_adjust",
                "detail": {"old": old, "new": new},
                "occurrence": count,
                "suggestion": f"标签修正模式出现了 {count} 次，建议检查关键词权重",
            })

    # 按 knowledge_tag 聚合被人类修正的频次
    human_corrected_tags: list[str] = []
    for c in corrections:
        if c.get("action") == "human_corrected":
            new_tags = c.get("new_tags", [])
            if isinstance(new_tags, str):
                import json
                try:
                    new_tags = json.loads(new_tags)
                except (json.JSONDecodeError, TypeError):
                    new_tags = []
            human_corrected_tags.extend(new_tags)

    tag_fix_counts = Counter(human_corrected_tags)
    for tag, count in tag_fix_counts.most_common(10):
        if count >= 3:
            patterns.append({
                "type": "keyword_coverage_gap",
                "detail": tag,
                "occurrence": count,
                "suggestion": f"知识点 '{tag}' 被人类修正了 {count} 次，提示关键词覆盖不足",
            })

    return patterns
