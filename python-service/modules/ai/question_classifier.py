"""Phase 2: 题目知识点自动分类模块。

基于 FTS 文档检索 + AI + 关键词兜底，为题目自动标注知识点。

三层架构：
  Layer 1: FTS 文档检索（主力）— 题目 → FTS5 检索 doc_chunks → 标签聚合
  Layer 2: AI 兜底 — 当 FTS 低置信或无匹配时，使用 LLM 根据知识树分类
  Layer 3: 关键词兜底 — FTS 和 AI 都失败时，使用关键词子字符串匹配
"""

from __future__ import annotations

import json
import re
from collections import defaultdict
from difflib import get_close_matches
from typing import Any, Optional

from loguru import logger


def _normalize_for_match(text: str) -> str:
    """归一化标签用于模糊匹配：小写、去空格、去括号内容。"""
    text = text.lower()
    text = re.sub(r"[\s（）()\[\]【】/、]", "", text)
    text = re.sub(r"[\\d一二三四五六七八九十]+", "", text)
    return text


def _find_best_tag_match(tag: str, valid_names: set[str]) -> str | None:
    """为 AI 返回的非规范标签寻找知识树中最接近的规范标签。

    匹配优先级：
      1. 精确匹配
      2. 规范化后相等
      3. 互相包含（知识树标签包含 AI 标签 / AI 标签包含知识树标签）
      4. difflib 模糊匹配（cutoff=0.6）
    """
    if tag in valid_names:
        return tag

    norm_tag = _normalize_for_match(tag)
    norm_names = {name: _normalize_for_match(name) for name in valid_names}

    # 规范化后相等
    for name, norm_name in norm_names.items():
        if norm_name == norm_tag:
            return name

    # 互相包含
    for name, norm_name in norm_names.items():
        if norm_tag in norm_name or norm_name in norm_tag:
            return name

    # difflib 模糊匹配
    best = get_close_matches(tag, valid_names, n=1, cutoff=0.6)
    if best:
        return best[0]

    # 用规范化后的字符串再做一次模糊匹配
    best_norm = get_close_matches(norm_tag, list(norm_names.values()), n=1, cutoff=0.7)
    if best_norm:
        for name, norm_name in norm_names.items():
            if norm_name == best_norm[0]:
                return name

    return None
def build_query_text(question: dict) -> str:
    """将题目多字段拼接为 FTS 查询文本。"""
    parts = [
        question.get("content", ""),
        " ".join(question.get("options", []) if isinstance(question.get("options"), list) else []),
        question.get("explanation", ""),
    ]
    return " ".join(p for p in parts if p)[:2000]


def _get_domain_ancestors(
    domain_map: dict[str, dict],
    name: str,
) -> set[str]:
    """获取知识点的所有祖先名称（含自身）。"""
    ancestors: set[str] = set()
    current = domain_map.get(name)
    visited = set()
    while current and current.get("name") not in visited:
        ancestors.add(current["name"])
        visited.add(current["name"])
        parent_id = current.get("parent_id")
        if parent_id and parent_id in domain_map:
            current = domain_map[parent_id]
        else:
            break
    return ancestors


def deduplicate_by_hierarchy(
    tag_scores: dict[str, float],
    domain_map: dict[str, dict],
) -> dict[str, float]:
    """层次去重：命中三级且其二级/一级也被命中时，降权祖先标签。

    规则：
      - 如果三级和其二级都被命中 → 三级权重不变，二级 × 0.3
      - 如果三级和其一级都被命中 → 一级 × 0.2
      - 如果二级和其一级都被命中（无三级命中）→ 一级 × 0.5
      - 如果后代的置信度总和 > 祖先的置信度 → 去掉祖先
    """
    if not tag_scores or len(tag_scores) <= 1:
        return tag_scores

    # 按 level 排序（三级 > 二级 > 一级）
    tag_levels = {}
    for tag in tag_scores:
        node = domain_map.get(tag, {})
        tag_levels[tag] = node.get("level", 1)

    # 找到每个标签的后代标签中是否也被命中
    deduped = dict(tag_scores)
    for tag in list(deduped.keys()):
        tag_level = tag_levels.get(tag, 1)
        if tag_level >= 3:
            continue  # 三级保留

        # 查找该标签的所有后代（通过 parent chain）
        descendant_score = 0.0
        for other_tag in deduped:
            other_level = tag_levels.get(other_tag, 1)
            if other_level <= tag_level:
                continue
            # 检查 other_tag 是否是 tag 的后代
            other_ancestors = _get_domain_ancestors(domain_map, other_tag)
            if tag in other_ancestors:
                descendant_score += tag_scores.get(other_tag, 0)

        # 降权规则
        if descendant_score > 0:
            if tag_level == 2:
                if descendant_score >= tag_scores[tag]:
                    deduped[tag] *= 0.2  # 有更强三级 → 大幅降权
                else:
                    deduped[tag] *= 0.5
            elif tag_level == 1:
                if descendant_score >= tag_scores[tag]:
                    deduped[tag] *= 0.1
                else:
                    deduped[tag] *= 0.3

    return deduped


def aggregate_tags(
    chunks: list[dict],
    domain_map: Optional[dict[str, dict]] = None,
    top_n: int = 3,
) -> list[dict]:
    """从检索到的 chunk 列表中聚合标签。

    Args:
        chunks: 检索到的 doc_chunk 列表，每项含 knowledge_tags, _score, confidence, page_num 等
        domain_map: name → {id, parent_id, name, level} 的知识领域映射
        top_n: 返回前 N 个标签

    Returns:
        [{tag, confidence, source_chunks: [{chunk_id, page_num, snippet}]}]
    """
    tag_scores: dict[str, float] = defaultdict(float)
    tag_sources: dict[str, list[dict]] = defaultdict(list)

    for chunk in chunks:
        chunk_weight = chunk.get("score", chunk.get("_score", 0.1))
        tags = chunk.get("knowledge_tags", [])
        if isinstance(tags, str):
            try:
                tags = json.loads(tags)
            except (json.JSONDecodeError, TypeError):
                tags = []

        snippet = (chunk.get("content", "") or "")[:120]

        for tag in tags:
            tag_scores[tag] += chunk_weight
            tag_sources[tag].append({
                "chunk_id": chunk.get("id", ""),
                "page_num": chunk.get("page_num", 0),
                "snippet": snippet,
            })

    # 层次去重
    if domain_map:
        tag_scores = deduplicate_by_hierarchy(dict(tag_scores), domain_map)

    # 归一化
    total = sum(tag_scores.values())
    if total > 0:
        for tag in tag_scores:
            tag_scores[tag] = tag_scores[tag] / total

    # 排序取前 N
    sorted_tags = sorted(tag_scores.items(), key=lambda x: x[1], reverse=True)
    selected = sorted_tags[:top_n]

    # 过滤掉置信度过低的标签（< 0.05）
    selected = [(t, c) for t, c in selected if c >= 0.05]

    return [
        {
            "tag": tag,
            "confidence": round(conf, 4),
            "source_chunks": tag_sources.get(tag, [])[:3],
        }
        for tag, conf in selected
    ]


def classify_question_tags_fts(
    query_text: str,
    search_results: list[dict],
    domain_map: Optional[dict[str, dict]] = None,
) -> dict:
    """对单个题目执行 FTS 检索 → 标签聚合流程。

    Args:
        query_text: 题目拼接文本
        search_results: searchDocChunks() 返回的检索结果列表
        domain_map: 知识领域映射

    Returns:
        {
            knowledge_tags: [...],
            confidence: [...],
            source: 'fts_document',
            layer1_confidence: float,  # Layer 1 的整体置信度
            needs_ai: bool,             # 是否需要 Layer 2 AI 兜底
        }
    """
    if not search_results:
        return {
            "knowledge_tags": [],
            "confidence": [],
            "source": "fts_document",
            "layer1_confidence": 0.0,
            "needs_ai": True,
        }

    # 标签聚合
    aggregated = aggregate_tags(search_results, domain_map, top_n=3)

    # 诊断日志
    _chunks_sample = [(c.get("knowledge_tags",[]), c.get("score", c.get("_score", 0))) for c in search_results[:3]]
    logger.debug("FTS classify: {} chunks, top scores={}, aggregated={}",
                 len(search_results), _chunks_sample, aggregated)

    if not aggregated:
        return {
            "knowledge_tags": [],
            "confidence": [],
            "source": "fts_document",
            "layer1_confidence": 0.0,
            "needs_ai": True,
        }

    tags = [a["tag"] for a in aggregated]
    confidences = [a["confidence"] for a in aggregated]

    # 判定是否需要进入 Layer 2
    top_score = confidences[0] if confidences else 0.0
    top_chunk_score = max((c.get("score", c.get("_score", 0)) for c in search_results), default=0)

    needs_ai = False
    # 规则 1: Top-1 得分低
    if top_chunk_score < 0.3:
        needs_ai = True
    # 规则 2: 标签来源少且得分均匀
    elif len(search_results) < 3 and top_score < 0.50:
        needs_ai = True
    # 规则 3: 多标签但得分太均匀（无法区分主次）
    elif len(aggregated) >= 2:
        if confidences[0] - confidences[-1] < 0.15:
            needs_ai = True

    return {
        "knowledge_tags": tags,
        "confidence": confidences,
        "source": "fts_document",
        "layer1_confidence": round(top_score, 4),
        "needs_ai": needs_ai,
    }


def classify_questions_batch(
    questions: list[dict],
    search_fn,  # (query_text: str) -> list[dict]
    domain_map: Optional[dict[str, dict]] = None,
) -> list[dict]:
    """批量题目自动标注。

    Args:
        questions: 题目列表 [{id, content, options, explanation, content_hash}]
        search_fn: 检索回调 (query_text) → 搜索结果列表
        domain_map: 知识领域映射

    Returns:
        [{question_id, knowledge_tags, confidence, source, layer1_confidence, needs_ai}]
    """
    results = []
    seen_hashes: dict[str, dict] = {}  # content_hash → result (去重)

    for q in questions:
        content_hash = q.get("content_hash", "")
        if content_hash and content_hash in seen_hashes:
            cached = dict(seen_hashes[content_hash])
            cached["question_id"] = q.get("id", "")
            cached["from_cache"] = True
            results.append(cached)
            continue

        query_text = build_query_text(q)
        search_results = search_fn(query_text)
        result = classify_question_tags_fts(query_text, search_results, domain_map)
        result["question_id"] = q.get("id", "")
        result["from_cache"] = False

        if content_hash:
            seen_hashes[content_hash] = result

        results.append(result)

    return results


def classify_question_keyword_fallback(
    text: str,
    domain_names: list[str],
) -> list[str]:
    """Layer 3: 关键词兜底 —— 简单的子字符串匹配。

    仅当 FTS 和 AI 都无法分类时使用。
    """
    from modules.pdf.router import KNOWLEDGE_TAG_KEYWORDS

    text_lower = text.lower()
    hits = []
    for tag in domain_names:
        keywords = KNOWLEDGE_TAG_KEYWORDS.get(tag, [])
        if any(kw in text_lower for kw in keywords):
            hits.append(tag)
    return hits[:3]


# ─── Layer 2: AI fallback helpers ────────────────────────────────────────────

CLASSIFY_QUESTION_SYSTEM_PROMPT = """你是《系统架构设计师》考试题目的分类专家。请根据教材内容为题目标注知识点。

## 知识领域体系（必须从以下列表中选择，不得编造）

{{domain_tree}}

## 教材中与本题最相关的段落（供参考）

{{top_chunks}}

## 要求
1. 从知识领域树中选择 1-3 个最相关的标签
2. 优先选择三级知识点（最具体）；如果不确定三级，可选二级或一级
3. 标签值必须是知识树中存在的完整名称，不得编造
4. 如果教材参考资料不足，请根据题目内容和解析中的专业术语直接判断所属知识领域
5. 如果确实不属于任何知识领域，返回空数组
6. 为每个标签给出置信度（0-1）

返回 JSON：
{
  "knowledge_tags": ["三级知识点完整名称"],
  "confidence": [0.95],
  "reasoning": "本题考察...，对应教材第X页的...内容"
}"""


def _extract_json(text: str) -> dict:
    """从 LLM 响应中提取 JSON 对象。"""
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if m:
        return json.loads(m.group(1))
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if m:
        return json.loads(m.group(0))
    raise ValueError(f"Cannot extract JSON from response: {text[:200]}")


def validate_ai_tags(
    tags: list[str],
    confidences: list[float],
    valid_names: set[str],
) -> dict:
    """校验 AI 返回的标签是否在知识树中。

    - 精确匹配 → 通过
    - 模糊/包含匹配 → 替换为最接近的规范名称并降权
    - 无匹配 → 丢弃该标签
    """
    if not tags:
        return {"knowledge_tags": [], "confidence": [], "validated": True}

    valid_tags = []
    valid_confidences = []

    for tag, conf in zip(tags, confidences):
        if tag in valid_names:
            valid_tags.append(tag)
            valid_confidences.append(conf)
            continue

        best_match = _find_best_tag_match(tag, valid_names)
        if best_match:
            valid_tags.append(best_match)
            valid_confidences.append(conf * 0.8)  # 模糊匹配降权
            logger.info("AI tag '{}' fuzzy-matched to '{}'", tag, best_match)
        else:
            logger.warning(
                "AI tag '{}' not in valid_names ({} names): [{}...]",
                tag, len(valid_names), ", ".join(sorted(valid_names)[:5])
            )

    if not valid_tags and tags:
        logger.warning(
            "All {} AI tags rejected. Valid names sample: {}",
            len(tags), sorted(valid_names)[:10]
        )

    return {
        "knowledge_tags": valid_tags,
        "confidence": valid_confidences,
        "validated": len(valid_tags) == len(tags),
    }


def _build_question_text(question: dict) -> str:
    """将题目格式化为给 LLM 阅读的文本。"""
    qtype = question.get("type", "single")
    type_label = {"single": "单选题", "multiple": "多选题", "case": "案例分析题", "essay": "论文题"}.get(
        qtype, qtype
    )
    options = question.get("options", [])
    options_text = "\n".join(options) if isinstance(options, list) else str(options)
    return (
        f"- 类型：{type_label}\n"
        f"- 内容：{question.get('content', '')}\n"
        f"- 选项：{options_text}\n"
        f"- 答案：{question.get('answer', '')}\n"
        f"- 解析：{question.get('explanation', '')}"
    )


async def classify_question_tags_ai(
    provider: Any,
    question: dict,
    domain_tree_text: str,
    valid_names: set[str],
    chunks: list[dict],
) -> dict:
    """使用 LLM 对单个题目进行分类。

    Returns:
        {
            knowledge_tags: [...],
            confidence: [...],
            reasoning: "...",
            ai_used: True,
            validated: True / False,
        }
    """
    chunk_parts = []
    for c in chunks[:3]:
        chunk_parts.append(
            f"【第{c.get('page_num', '?')}页】{c.get('content', '')[:400]}"
        )
    chunks_text = "\n\n---\n\n".join(chunk_parts) if chunk_parts else "（无匹配教材段落）"

    system_prompt = CLASSIFY_QUESTION_SYSTEM_PROMPT.replace(
        "{{domain_tree}}", domain_tree_text
    ).replace(
        "{{top_chunks}}", chunks_text
    )

    question_text = _build_question_text(question)

    raw = await provider.chat(
        [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": f"请为以下题目分类标注知识点：\n\n{question_text[:2000]}"},
        ],
        temperature=0.3,
    )
    parsed = _extract_json(raw)
    tags = parsed.get("knowledge_tags", [])
    confs = parsed.get("confidence", [])
    logger.info("AI classify q={}: raw_tags={}", question.get("id", "?"), tags)

    validated = validate_ai_tags(tags, confs, valid_names)
    return {
        "knowledge_tags": validated["knowledge_tags"],
        "confidence": validated["confidence"],
        "reasoning": parsed.get("reasoning", ""),
        "ai_used": True,
        "validated": validated["validated"],
    }


def classify_question_tags_keyword(
    question: dict,
    valid_names: list[str],
) -> dict:
    """关键词兜底：对题目文本做子字符串匹配。

    Returns:
        {
            knowledge_tags: [...],
            confidence: [...],
            source: "keyword_fallback",
            ai_used: False,
        }
    """
    text = build_query_text(question)
    hits = classify_question_keyword_fallback(text, valid_names)
    return {
        "knowledge_tags": hits,
        "confidence": [0.5 for _ in hits],
        "source": "keyword_fallback",
        "ai_used": False,
    }


async def classify_question_with_fallback(
    question: dict,
    search_results: list[dict],
    domain_map: Optional[dict[str, dict]],
    provider: Any | None,
    domain_tree_text: str,
    valid_names: set[str],
) -> dict:
    """执行 FTS → AI → 关键词的完整兜底链。

    Returns:
        {
            question_id: str,
            knowledge_tags: [...],
            confidence: [...],
            source: "fts_document" | "ai_classifier" | "keyword_fallback",
            layer1_confidence: float,
            needs_ai: bool,
            ai_used: bool,
            reasoning: str,
        }
    """
    query_text = build_query_text(question)

    # Layer 1: FTS
    l1 = classify_question_tags_fts(query_text, search_results, domain_map)

    # 如果 FTS 结果足够好，直接返回
    if l1.get("knowledge_tags") and not l1.get("needs_ai"):
        return {
            "question_id": question.get("id", ""),
            "content_hash": question.get("content_hash", ""),
            "knowledge_tags": l1["knowledge_tags"],
            "confidence": l1["confidence"],
            "source": "fts_document",
            "layer1_confidence": l1.get("layer1_confidence", 0.0),
            "needs_ai": False,
            "ai_used": False,
            "reasoning": "",
        }

    # Layer 2: AI
    if provider is not None:
        try:
            ai_result = await classify_question_tags_ai(
                provider, question, domain_tree_text, valid_names, search_results
            )
            if ai_result.get("knowledge_tags"):
                return {
                    "question_id": question.get("id", ""),
                    "content_hash": question.get("content_hash", ""),
                    "knowledge_tags": ai_result["knowledge_tags"],
                    "confidence": ai_result["confidence"],
                    "source": "ai_classifier",
                    "layer1_confidence": l1.get("layer1_confidence", 0.0),
                    "needs_ai": False,
                    "ai_used": True,
                    "reasoning": ai_result.get("reasoning", ""),
                }
        except Exception as e:
            logger.warning("AI classify question {} failed: {}", question.get("id", "?"), e)

    # Layer 3: keyword fallback
    kw_result = classify_question_tags_keyword(question, list(valid_names))
    if kw_result.get("knowledge_tags"):
        return {
            "question_id": question.get("id", ""),
            "content_hash": question.get("content_hash", ""),
            "knowledge_tags": kw_result["knowledge_tags"],
            "confidence": kw_result["confidence"],
            "source": "keyword_fallback",
            "layer1_confidence": l1.get("layer1_confidence", 0.0),
            "needs_ai": False,
            "ai_used": False,
            "reasoning": "",
        }

    # Nothing worked
    return {
        "question_id": question.get("id", ""),
        "content_hash": question.get("content_hash", ""),
        "knowledge_tags": [],
        "confidence": [],
        "source": "fts_document",
        "layer1_confidence": l1.get("layer1_confidence", 0.0),
        "needs_ai": False,
        "ai_used": False,
        "reasoning": "",
    }
