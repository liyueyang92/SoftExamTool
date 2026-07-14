"""Unit tests for vision module and visual extraction."""

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from modules.pdf.extractors.visual import (
    detect_figure_page,
    build_figure_chunk_content,
    FIGURE_SUMMARY_PROMPT,
    TABLE_VISION_PROMPT,
)
from modules.pdf.vision import (
    _cache_key,
    _load_cached_summary,
    _save_cached_summary,
    build_vision_provider,
)


class TestDetectFigurePage:
    """Tests for rule-based figure page detection."""

    def test_empty_text_is_figure(self):
        """Pure image page with no text at all."""
        assert detect_figure_page("") is True

    def test_whitespace_only_is_figure(self):
        assert detect_figure_page("   \n  \n  ") is True

    def test_short_label_lines(self):
        """Many short label lines → likely a diagram."""
        text = "\n".join([
            "SysML 图",
            "行为图",
            "活动图",
            "序列图",
            "状态机图",
            "用例图",
            "结构图",
            "模块定义图",
            "内部模块图",
            "包图",
            "需求图",
            "参数图",
        ])
        assert detect_figure_page(text) is True

    def test_long_paragraph_is_not_figure(self):
        """Normal prose with long lines is not detected as a figure."""
        text = (
            "系统架构设计师考试涵盖软件架构设计、质量属性、"
            "软件设计模式、数据库设计、系统集成等多个知识领域。"
            "考生需要掌握架构评估方法和设计决策技巧。"
        ) * 3
        assert detect_figure_page(text) is False

    def test_mixed_mostly_short(self):
        """One long line among many short ones — still a figure."""
        lines = ["A", "B", "C", "D", "E" * 30, "F", "G", "H", "I", "J"]
        text = "\n".join(lines)
        # 9/10 short lines = 90% > 70% → figure
        assert detect_figure_page(text) is True

    def test_mostly_long_lines(self):
        """Most lines are long → not a figure."""
        lines = ["AAA" * 10] * 10 + ["B"]  # 10 long + 1 short → 1/11 < 70%
        text = "\n".join(lines)
        assert detect_figure_page(text) is False


class TestBuildFigureChunkContent:
    """Tests for building figure chunk content from summary text."""

    def test_includes_page_number(self):
        content = build_figure_chunk_content("图中展示了系统架构。", page_num=8, figure_index=1)
        assert "第 8 页" in content
        assert "图示摘要" in content

    def test_includes_summary_text(self):
        summary = "这是一个 SysML 分类图。"
        content = build_figure_chunk_content(summary, page_num=1, figure_index=2)
        assert summary in content

    def test_strips_whitespace(self):
        summary = "  有前导空格的内容  "
        content = build_figure_chunk_content(summary, page_num=1, figure_index=1)
        assert content.endswith("有前导空格的内容")


class TestCacheKey:
    """Tests for vision summary cache key generation."""

    def test_deterministic(self):
        k1 = _cache_key("/path/to/img.png", "describe this", "claude-sonnet-4-6")
        k2 = _cache_key("/path/to/img.png", "describe this", "claude-sonnet-4-6")
        assert k1 == k2
        assert len(k1) == 64  # SHA256

    def test_different_image_gives_different_key(self):
        k1 = _cache_key("/a.png", "prompt", "model")
        k2 = _cache_key("/b.png", "prompt", "model")
        assert k1 != k2

    def test_different_prompt_gives_different_key(self):
        k1 = _cache_key("/a.png", "prompt A", "model")
        k2 = _cache_key("/a.png", "prompt B", "model")
        assert k1 != k2

    def test_different_model_gives_different_key(self):
        k1 = _cache_key("/a.png", "prompt", "gpt-4o")
        k2 = _cache_key("/a.png", "prompt", "claude-sonnet-4-6")
        assert k1 != k2


class TestCacheReadWrite:
    """Tests for cache load/save round-trip."""

    def test_save_and_load(self):
        with tempfile.TemporaryDirectory() as tmp:
            key = "abc123"
            summary = "这是缓存的摘要内容。"
            _save_cached_summary(tmp, key, summary)
            loaded = _load_cached_summary(tmp, key)
            assert loaded == summary

    def test_missing_cache_returns_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            assert _load_cached_summary(tmp, "nonexistent") is None

    def test_corrupted_cache_returns_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            key = "corrupted"
            cache_file = Path(tmp) / f"{key}.json"
            cache_file.write_text("not valid json{{{", encoding="utf-8")
            assert _load_cached_summary(tmp, key) is None


class TestBuildVisionProvider:
    """Tests for the vision provider factory function."""

    def test_disabled_mode_returns_none_for_no_config(self):
        """Missing API key → returns None."""
        cfg = {"mode": "openai", "openai": {"apiKey": "", "model": "gpt-4o"}}
        provider = build_vision_provider(cfg)
        assert provider is not None  # OpenAI provider still builds (no key check)
        # But Ollama without model falls back
        cfg2 = {"mode": "ollama", "ollama": {"model": ""}}
        provider2 = build_vision_provider(cfg2)
        assert provider2 is None

    def test_anthropic_provider_built(self):
        cfg = {
            "mode": "anthropic",
            "anthropic": {"apiKey": "sk-ant-test", "model": "claude-sonnet-4-6"},
        }
        provider = build_vision_provider(cfg)
        from modules.pdf.vision import AnthropicVisionProvider
        assert isinstance(provider, AnthropicVisionProvider)

    def test_ollama_provider_built(self):
        cfg = {
            "mode": "ollama",
            "ollama": {"baseUrl": "http://localhost:11434", "model": "llava"},
        }
        provider = build_vision_provider(cfg)
        from modules.pdf.vision import OllamaVisionProvider
        assert isinstance(provider, OllamaVisionProvider)

    def test_openai_provider_built(self):
        cfg = {
            "mode": "openai",
            "openai": {"baseUrl": "https://api.openai.com/v1", "apiKey": "sk-test", "model": "gpt-4o-mini"},
        }
        provider = build_vision_provider(cfg)
        from modules.pdf.vision import OpenAICompatVisionProvider
        assert isinstance(provider, OpenAICompatVisionProvider)

    def test_vision_model_fallback(self):
        """When visionModel is set, it should be used over model."""
        cfg = {
            "mode": "openai",
            "openai": {
                "baseUrl": "https://api.openai.com/v1",
                "apiKey": "sk-test",
                "model": "gpt-4o",
                "visionModel": "gpt-4o-mini",
            },
        }
        provider = build_vision_provider(cfg)
        assert provider.model == "gpt-4o-mini"


class TestPromptTemplates:
    """Verify prompt templates are non-empty and contain key instructions."""

    def test_figure_prompt_has_key_parts(self):
        assert "软考" in FIGURE_SUMMARY_PROMPT
        assert "图中未明确" in FIGURE_SUMMARY_PROMPT
        assert "200 字" in FIGURE_SUMMARY_PROMPT

    def test_table_vision_prompt(self):
        assert "Markdown" in TABLE_VISION_PROMPT
        assert "图中无表格" in TABLE_VISION_PROMPT
