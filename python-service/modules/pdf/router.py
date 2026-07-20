import asyncio
import hashlib
import json
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
from modules.progress import push_complete, push_error, push_partial, push_progress

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

# 标签名与计划调度器 NORMAL_SCHEDULE 及 outline-sys-architect.json 完全对齐
KNOWLEDGE_TAG_KEYWORDS: dict[str, list[str]] = {
    "计算机组成与体系结构": [
        "计算机组成", "体系结构", "cpu", "指令集", "cisc", "risc", "flynn",
        "流水线", "cache", "缓存", "虚拟存储", "磁盘阵列", "raid", "总线",
        "嵌入式", "实时系统", "rtos", "单片机", "驱动程序", "中断", "dma",
        "冯诺依曼", "哈佛结构", "mips", "mflops", "amdahl", "加速比",
        "超标量", "超流水线", "寄存器", "alu", "控制器",
    ],
    "操作系统原理": [
        "操作系统", "进程", "线程", "死锁", "银行家算法", "pv操作", "信号量",
        "处理机调度", "fcfs", "sjf", "时间片", "多级反馈队列", "存储管理",
        "分页", "分段", "页面置换", "opt", "lru", "fifo", "文件系统",
        "inode", "磁盘调度", "sstf", "scan", "i/o", "设备管理", "spooling",
    ],
    "数据库系统": [
        "数据库", "sql", "事务", "索引", "er图", "关系模型", "nosql", "mongodb",
        "redis", "关系代数", "规范化", "1nf", "2nf", "3nf", "bcnf", "函数依赖",
        "acid", "并发控制", "封锁", "两段锁", "mvcc", "查询优化", "b+树",
        "分布式事务", "2pc", "3pc", "cap", "base", "newsql",
    ],
    "计算机网络": [
        "计算机网络", "网络", "tcp", "udp", "http", "https", "osi", "协议",
        "路由", "交换机", "dns", "ftp", "dhcp", "子网划分", "cidr", "vlsm",
        "拥塞控制", "流量控制", "vlan", "stp", "链路聚合", "ipv6", "snmp",
        "网络安全", "防火墙", "ssl", "tls", "vpn", "nat",
    ],
    "软件工程基础": [
        "软件工程", "软件过程", "开发模型", "瀑布", "敏捷", "scrum", "xp",
        "devops", "ci/cd", "需求分析", "uml", "用例图", "类图", "时序图",
        "设计模式", "solid", "耦合", "内聚", "测试", "单元测试", "集成测试",
        "项目管理", "进度", "成本", "风险", "甘特图", "wbs", "pmbok",
        "cmmi", "质量保证", "配置管理", "git",
    ],
    "系统规划与分析": [
        "系统规划", "可行性分析", "需求工程", "业务建模", "数据流图", "dfd",
        "数据字典", "结构化分析", "面向对象分析", "用例建模", "领域模型",
        "成本估算", "cocomo", "功能点", "净现值", "投资回报", "tco",
    ],
    "系统设计": [
        "系统设计", "概要设计", "详细设计", "模块划分", "接口设计",
        "集成", "esb", "消息队列", "mq", "webservice", "api", "rest",
        "soap", "grpc", "微服务", "服务治理", "服务编排", "edi", "eai",
        "中间件", "soa", "组件设计", "分层架构", "设计评审",
    ],
    "软件架构设计": [
        "架构", "架构设计", "架构风格", "架构模式", "mvc", "mvp", "mvvm",
        "分层", "管道过滤器", "事件驱动", "微内核", "基于构件", "面向服务",
        "架构评估", "atam", "saam", "质量属性", "可用性", "性能", "可修改性",
        "可测试性", "安全性", "可移植性", "adl", "架构描述", "4+1视图",
        "架构决策", "技术选型", "架构重构",
    ],
    "系统安全设计": [
        "安全设计", "安全", "加密", "认证", "授权", "pki", "ca证书",
        "数字签名", "访问控制", "rbac", "xss", "sql注入", "csrf",
        "安全审计", "入侵检测", "ids", "ips", "漏洞", "渗透", "安全评估",
        "安全架构", "零信任", "纵深防御", "隐私保护", "gdpr", "数据脱敏",
    ],
    "系统可靠性": [
        "可靠性", "可用性", "容错", "冗余", "备份", "灾难恢复", "故障转移",
        "集群", "负载均衡", "高可用", "mtbf", "mttr", "rto", "rpo",
        "监控", "告警", "降级", "熔断", "限流", "隔离", "弹性", "健壮性",
    ],
    "标准化与知识产权": [
        "标准化", "知识产权", "著作权", "专利", "商标", "软件版权", "开源许可",
        "gpl", "mit", "apache", "iso", "ieee", "国家标准", "行业标准",
        "商业秘密", "合同法", "招投标",
    ],
    "案例分析专项": [
        "案例分析", "案例", "方案设计", "需求分析", "技术选型", "架构评估",
        "系统规划", "性能优化", "安全方案", "容灾方案", "数据架构",
        "集成方案", "项目计划", "风险评估", "运维方案",
    ],
    "论文写作专项": [
        "摘要", "论文", "项目背景", "技术难点", "解决方案", "总结",
        "论文写作", "论题", "论点", "论据", "正文", "引言", "结论",
        "实践", "工程实践", "项目经验", "技术路线",
    ],
}


def classify_knowledge_tags(text: str) -> list[str]:
    tags: list[str] = []
    text_lower = text.lower()
    for tag, keywords in KNOWLEDGE_TAG_KEYWORDS.items():
        if any(keyword in text_lower for keyword in keywords):
            tags.append(tag)
    return tags[:3]


# ─── A1: Noise page detection ─────────────────────────────────────────────────

PREFACE_KEYWORDS = ["前言", "序言", "编写说明", "编者按", "如何使用本书", "致谢", "出版说明"]
COPYRIGHT_KEYWORDS = ["ISBN", "CIP", "版权所有", "版次", "印刷", "定价", "开本", "印张", "字数"]
APPENDIX_KEYWORDS = ["附录", "参考文献", "参考书目", "索引", "名词索引"]

TOC_DOTS_PATTERN = re.compile(r'…+\s*\d+\s*$|\.{3,}\s*\d+\s*$', re.MULTILINE)
CHAPTER_COUNT_PATTERN = re.compile(r'第[一二三四五六七八九十\d]+章')


def is_noise_page(text: str, page_num: int, total_pages: int) -> tuple[bool, str]:
    """返回 (是否噪音, 噪音类型)

    噪音类型: toc / preface / copyright / chapter_title / appendix
    """
    # 目录页检测
    if TOC_DOTS_PATTERN.search(text) or "目录" in text[:50]:
        chapters = CHAPTER_COUNT_PATTERN.findall(text)
        if len(chapters) >= 3 or "目录" in text[:50]:
            return True, "toc"

    # 前言页检测
    early_pages = max(15, int(total_pages * 0.05))
    if page_num <= early_pages:
        if any(kw in text for kw in PREFACE_KEYWORDS):
            # 检查是否包含技术关键词
            has_tech = any(
                any(keyword in text.lower() for keyword in keywords)
                for keywords in KNOWLEDGE_TAG_KEYWORDS.values()
            )
            if not has_tech:
                return True, "preface"

    # 版权页检测
    copyright_hits = sum(1 for kw in COPYRIGHT_KEYWORDS if kw in text)
    if copyright_hits >= 3:
        return True, "copyright"

    # 章标题页
    if len(text.strip()) < 100 and CHAPTER_COUNT_PATTERN.search(text):
        return True, "chapter_title"

    # 附录/索引页
    late_pages = max(10, int(total_pages * 0.05))
    if page_num >= total_pages - late_pages:
        if any(kw in text[:100] for kw in APPENDIX_KEYWORDS):
            return True, "appendix"

    return False, ""


# ─── A2: Graded keyword matching ──────────────────────────────────────────────

# 关键词特异性权重常量
HIGH_SPECIFICITY = 3.0
MEDIUM_SPECIFICITY = 1.5
LOW_SPECIFICITY = 0.5

# 默认通用词权重阈值（长关键词 > 5 字符视为高特异性，3-5 字符中特异性，其他低特异性）
_MIN_HIGH_CHARS = 6
_MIN_MEDIUM_CHARS = 3


def _auto_grade_keywords(keywords: list[str]) -> dict[str, list[tuple[str, float]]]:
    """将平铺关键词列表自动划分 high / medium / low 三级并附加权重。

    启发式规则：
      - 含中文且 >= 4 个汉字 → high (3.0)
      - 纯英文/数字且长度 >= 6 → high (3.0)
      - 否则长度 >= 3 → medium (1.5)
      - 其余 → low (0.5)
    """
    graded: dict[str, list[tuple[str, float]]] = {"high": [], "medium": [], "low": []}
    for kw in keywords:
        # 中文字符计数
        cjk = sum(1 for ch in kw if '一' <= ch <= '鿿')
        if cjk >= 4:
            graded["high"].append((kw, HIGH_SPECIFICITY))
        elif kw.isascii() and len(kw) >= _MIN_HIGH_CHARS:
            graded["high"].append((kw, HIGH_SPECIFICITY))
        elif len(kw) >= _MIN_MEDIUM_CHARS:
            graded["medium"].append((kw, MEDIUM_SPECIFICITY))
        else:
            graded["low"].append((kw, LOW_SPECIFICITY))
    return graded


# 构建分级关键词字典（从现有 KNOWLEDGE_TAG_KEYWORDS 自动分级）
KNOWLEDGE_TAG_KEYWORDS_V2: dict[str, dict[str, list[tuple[str, float]]]] = {
    tag: _auto_grade_keywords(kws) for tag, kws in KNOWLEDGE_TAG_KEYWORDS.items()
}

# 负向条件：常见歧义词需要额外验证上下文
NEGATIVE_CONDITIONS: dict[str, dict] = {
    "进程": {
        "require_any": ["操作系统", "死锁", "PCB", "调度", "信号量", "PV操作", "线程", "处理机"],
        "else_tag": None,
    },
    "索引": {
        "require_any": ["数据库", "SQL", "B+树", "查询优化", "哈希", "事务"],
        "else_tag": None,
    },
    "架构": {
        "require_any": ["软件架构", "架构设计", "架构风格", "ATAM", "架构评估", "4+1"],
        "else_tag": "系统设计",
    },
    "系统": {
        "require_any": ["系统设计", "系统规划", "系统架构", "体系结构", "模块"],
        "else_tag": None,
    },
    "安全": {
        "require_any": ["加密", "认证", "防火墙", "漏洞", "审计", "数据安全"],
        "else_tag": None,
    },
    "网络": {
        "require_any": ["TCP", "IP", "路由", "HTTP", "OSI", "协议", "子网", "DNS"],
        "else_tag": None,
    },
    "测试": {
        "require_any": ["单元测试", "集成测试", "测试用例", "覆盖率", "自动化测试", "软件测试"],
        "else_tag": None,
    },
    "可靠性": {
        "require_any": ["MTBF", "MTTR", "容错", "冗余", "备份", "故障", "高可用", "熔断"],
        "else_tag": None,
    },
}


def classify_knowledge_tags_v2(text: str) -> tuple[list[str], float]:
    """返回 (标签列表, 整体置信度)

    使用分级关键词匹配 + 负向条件过滤，比 v1 有更好的去噪能力。
    """
    text_lower = text.lower()
    tag_scores: dict[str, float] = {}

    for tag, weight_groups in KNOWLEDGE_TAG_KEYWORDS_V2.items():
        total_weight = 0.0
        hit_weight = 0.0

        for tier, keywords in weight_groups.items():
            w = {
                "high": HIGH_SPECIFICITY,
                "medium": MEDIUM_SPECIFICITY,
                "low": LOW_SPECIFICITY,
            }[tier]

            for keyword, kw_weight in keywords:
                total_weight += kw_weight
                if keyword in text_lower:
                    # 检查负向条件
                    if keyword in NEGATIVE_CONDITIONS:
                        cond = NEGATIVE_CONDITIONS[keyword]
                        if not any(req.lower() in text_lower for req in cond["require_any"]):
                            continue
                    hit_weight += kw_weight

        if total_weight > 0:
            score = hit_weight / total_weight
            if score >= 0.10:  # 最低阈值
                tag_scores[tag] = score

    sorted_tags = sorted(tag_scores.items(), key=lambda x: x[1], reverse=True)
    selected = sorted_tags[:3]

    tags = [t[0] for t in selected]
    confidence = selected[0][1] if selected else 0.0

    return tags, confidence


# ─── C: Confidence scoring ────────────────────────────────────────────────────


def _compute_position_score(
    is_noise: bool, noise_type: str, page_num: int, total_pages: int, text_len: int
) -> float:
    """页面位置评分 (0-1)"""
    if is_noise:
        return 0.0
    if text_len < 100:
        return 0.0

    ratio = page_num / max(total_pages, 1)

    if ratio <= 0.05:
        return 0.3
    if ratio <= 0.10:
        return 0.6
    if ratio <= 0.90:
        return 1.0
    return 0.5


def _compute_keyword_score(tags: list[str], tag_confidences: dict[str, float]) -> float:
    """关键词匹配评分 (0-1)，直接复用 classify 阶段的 top-1 置信度"""
    if not tags:
        return 0.0
    top_conf = tag_confidences.get(tags[0], 0.0)
    return min(1.0, top_conf)


def _compute_content_score(text: str, chunk_type: str = "text") -> float:
    """内容质量评分 (0-1)"""
    text_len = len(text)

    # 长度评分
    if text_len >= 200:
        length_score = 1.0
    elif text_len >= 100:
        length_score = 0.8
    elif text_len >= 50:
        length_score = 0.5
    else:
        length_score = 0.3

    # 特殊字符占比
    special_chars = sum(1 for ch in text if not ch.isalnum() and not ch.isspace())
    special_ratio = special_chars / max(text_len, 1)
    if special_ratio > 0.4:
        length_score *= 0.75

    # 按 chunk_type 调整
    if chunk_type == "table":
        return length_score * 0.9
    if chunk_type == "figure":
        return length_score * 0.6
    return length_score


def compute_chunk_confidence(
    tags: list[str],
    tag_confidences: dict[str, float],
    page_num: int,
    total_pages: int,
    text: str,
    chunk_type: str = "text",
    noise_type: str = "",
    neighbor_tags: list[str] | None = None,
) -> float:
    """计算 chunk 标签的整体置信度 (0-1)

    公式:
      position_score   × 0.25
      + keyword_score  × 0.40
      + neighbor_score × 0.20
      + content_score  × 0.15

    neighbor_tags 在解析时可为 None（邻居尚未就绪），此时 neighbor_score 取 0.5。
    """
    is_noise = bool(noise_type and noise_type != "")

    position_score = _compute_position_score(is_noise, noise_type, page_num, total_pages, len(text))
    keyword_score = _compute_keyword_score(tags, tag_confidences)
    content_score = _compute_content_score(text, chunk_type)

    # 邻居一致性分
    if is_noise:
        neighbor_score = 0.0
    elif neighbor_tags is None:
        neighbor_score = 0.5  # 解析时无邻居信息，默认中性值
    elif not tags:
        neighbor_score = 0.5
    elif not neighbor_tags:
        neighbor_score = 1.0  # 邻居均无标签（可能是独立主题），不惩罚
    else:
        shared = sum(1 for tag in tags if tag in neighbor_tags)
        neighbor_score = shared / max(len(tags), 1)

    confidence = (
        position_score * 0.25
        + keyword_score * 0.40
        + neighbor_score * 0.20
        + content_score * 0.15
    )
    return round(min(1.0, max(0.0, confidence)), 4)


# ─── Modified chunk_text (uses v2 classifier + noise detection) ────────────────


def chunk_text(
    text: str,
    page_num: int,
    doc_id: str,
    min_length: int = 50,
    total_pages: int | None = None,
) -> list[dict]:
    chunks: list[dict] = []

    # 噪声页面检测
    effective_total = total_pages or page_num  # fallback: assume single-page if unknown
    is_noise, noise_type = is_noise_page(text, page_num, effective_total)

    paragraphs = re.split(r"\n{2,}|(?=第[一二三四五六七八九十\d]+[章节])", text)
    for paragraph in paragraphs:
        paragraph = paragraph.strip()
        if len(paragraph) < min_length:
            continue
        tags, tag_conf = classify_knowledge_tags_v2(paragraph)
        if is_noise:
            tags, tag_conf = [], 0.0
        confidence = compute_chunk_confidence(
            tags,
            {tags[0]: tag_conf} if tags else {},
            page_num,
            effective_total,
            paragraph,
            "text",
            noise_type,
        )
        chunks.append(
            {
                "doc_id": doc_id,
                "page_num": page_num,
                "content": paragraph[:2000],
                "knowledge_tags": tags,
                "chunk_type": "text",
                "source_engine": "",
                "confidence": confidence,
                "block_order": 0,
                "bbox": None,
                "_noise_type": noise_type,
            }
        )

    if not chunks and len(text.strip()) >= min_length:
        tags, tag_conf = classify_knowledge_tags_v2(text)
        if is_noise:
            tags, tag_conf = [], 0.0
        confidence = compute_chunk_confidence(
            tags,
            {tags[0]: tag_conf} if tags else {},
            page_num,
            effective_total,
            text,
            "text",
            noise_type,
        )
        chunks.append(
            {
                "doc_id": doc_id,
                "page_num": page_num,
                "content": text.strip()[:2000],
                "knowledge_tags": tags,
                "chunk_type": "text",
                "source_engine": "",
                "confidence": confidence,
                "block_order": 0,
                "bbox": None,
                "_noise_type": noise_type,
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
    on_page_done: Optional[callable] = None,
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
            total_selected = effective_end_page - effective_start_page + 1

            for page_index in selected_pages:
                page_num = page_index + 1
                # 记录处理前的长度，用于提取本页新增内容
                chunks_before = len(all_chunks)
                assets_before = len(assets)
                warnings_before = len(warnings)

                pdfium_page = pdfium_doc.get_page(page_index) if pdfium_doc is not None else None
                try:
                    text, engine = extract_page_text(
                        pdf.pages[page_index],
                        pdfium_page,
                        top_margin_ratio,
                        bottom_margin_ratio,
                    )

                    # 噪声页面检测（整页只执行一次）
                    page_is_noise, page_noise_type = is_noise_page(text, page_num, page_count)

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

                        # 使用 v2 分类器（噪声页直接标空）
                        if page_is_noise:
                            tb_tags, tb_confidence = [], 0.0
                        else:
                            tb_tags, tb_confidence = classify_knowledge_tags_v2(tb["content"])
                        all_chunks.append({
                            "doc_id": doc_id,
                            "page_num": page_num,
                            "content": tb["content"],
                            "knowledge_tags": tb_tags,
                            "chunk_type": tb["chunk_type"],
                            "asset_id": table_asset_id,
                            "source_engine": tb["source_engine"],
                            "confidence": tb_confidence,
                            "block_order": tb["block_order"],
                            "bbox": json.dumps(tb["bbox"], ensure_ascii=False),
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
                                    "knowledge_tags": (
                                        [] if page_is_noise
                                        else classify_knowledge_tags_v2(figure_result["content"])[0]
                                    ),
                                    "chunk_type": "figure",
                                    "asset_id": page_asset_id,
                                    "source_engine": figure_result["source_engine"],
                                    "confidence": (
                                        0.0 if page_is_noise
                                        else figure_result["confidence"]
                                    ),
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
                    text_chunks = chunk_text(text, page_num, doc_id, total_pages=page_count)
                    for tc in text_chunks:
                        if page_asset_id:
                            tc["asset_id"] = page_asset_id
                    all_chunks.extend(text_chunks)

                # 提取本页新增的 chunks / assets / warnings
                page_chunks = all_chunks[chunks_before:]
                page_assets = assets[assets_before:]
                page_warnings = warnings[warnings_before:]

                if on_page_done is not None:
                    try:
                        on_page_done(page_num, total_selected, {
                            "chunks": page_chunks,
                            "assets": page_assets,
                            "warnings": page_warnings,
                        })
                    except Exception as exc:
                        logger.warning("on_page_done callback failed for page {}: {}", page_num, exc)

        # 清理内部字段，仅保留 DB 所需的键
        for c in all_chunks:
            c.pop("_noise_type", None)

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
        loop = asyncio.get_event_loop()

        def on_page_done(page_num: int, total_pages: int, partial: dict) -> None:
            """在后台线程中回调，安排异步推送中间结果"""
            asyncio.run_coroutine_threadsafe(
                push_partial(
                    task_id,
                    page_num,
                    total_pages,
                    partial.get("chunks", []),
                    partial.get("assets", []),
                    partial.get("warnings", []),
                ),
                loop,
            )

        # 在线程池中执行同步解析，避免阻塞事件循环
        # 这样每个页面的 on_page_done 回调可以通过 asyncio.run_coroutine_threadsafe
        # 将中间结果推送到 WebSocket
        result = await loop.run_in_executor(
            None,
            lambda: parse_pdf_pages(
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
                on_page_done=on_page_done,
            ),
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


# ─── Phase 0: Document tag cleaning endpoints ─────────────────────────────────

class CleanChunksRequest(BaseModel):
    """批量清洗 chunk 标签的请求。"""
    chunks: list[dict]  # 每个 dict 至少含 content, page_num, id(opt), chunk_type(opt)
    total_pages: int


class CleanChunksResponse(BaseModel):
    cleaned_chunks: list[dict]
    report: dict
    needs_ai: list[dict]  # 需要 AI 重分类的低置信度 chunk


@router.post("/clean-chunks", response_model=CleanChunksResponse)
async def clean_chunks(req: CleanChunksRequest):
    """对给定 chunk 列表执行标签清洗，返回清洗结果和报告。"""
    from modules.pdf.cleaner import clean_chunks_batch, generate_cleaning_report, get_chunks_needing_ai

    try:
        results = clean_chunks_batch(req.chunks, req.total_pages)
        report = generate_cleaning_report(results)
        needs_ai = get_chunks_needing_ai(results)
        logger.info(
            "Cleaned {} chunks: noise={}, low_conf={}, needs_ai={}",
            len(results),
            report.get("noise_cleared", {}),
            report.get("actions", {}).get("low_confidence_cleared", 0),
            len(needs_ai),
        )
        return CleanChunksResponse(
            cleaned_chunks=results,
            report=report,
            needs_ai=needs_ai,
        )
    except Exception as exc:
        logger.exception("Chunk cleaning failed")
        raise HTTPException(status_code=500, detail=f"清洗失败: {exc}")
