"""Unit tests for RAG retrieval and AI context formatting."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from modules.ai.router import RAG_SYSTEM_PROMPT


class TestRagSystemPrompt:
    """Verify the RAG system prompt covers table/figure instructions."""

    def test_mentions_markdown_table(self):
        assert "Markdown 表格" in RAG_SYSTEM_PROMPT
        assert "行列关系" in RAG_SYSTEM_PROMPT

    def test_mentions_figure_summary(self):
        assert "图示摘要" in RAG_SYSTEM_PROMPT
        assert "结构、关系、层级" in RAG_SYSTEM_PROMPT

    def test_mentions_citation_format(self):
        assert "页码" in RAG_SYSTEM_PROMPT
        assert "内容类型" in RAG_SYSTEM_PROMPT

    def test_mentions_uncertainty_handling(self):
        assert "不足以回答问题" in RAG_SYSTEM_PROMPT


class TestContextFormatting:
    """Tests for the chunk context formatting logic in ai_chat."""

    @staticmethod
    def _format_chunks(doc_chunks: list[dict]) -> str:
        """Replicate the formatting logic from ai_chat for testing."""
        if not doc_chunks:
            return ""

        parts = []
        for c in doc_chunks[:5]:
            chunk_type = c.get("chunk_type", "text")
            type_hint = {
                "table": "（以下为Markdown表格，请按行列关系理解）",
                "figure": "（以下为图片/流程图描述，可用于回答结构、分类、关系类问题）",
                "page_summary": "（以下为页面摘要）",
            }.get(chunk_type, "")

            parts.append(
                f'【第{c.get("page_num", "?")}页 · {c.get("doc_title", "文档")}'
                f' · {chunk_type}】{type_hint}\n'
                f'{c["content"][:800]}'
            )
        return '\n\n---\n\n'.join(parts)

    def test_text_chunk_no_hint(self):
        chunks = [{"page_num": 1, "doc_title": "Test", "content": "Hello", "chunk_type": "text"}]
        result = self._format_chunks(chunks)
        assert "【第1页 · Test · text】" in result
        assert "（以下为Markdown）" not in result
        assert "Hello" in result

    def test_table_chunk_has_hint(self):
        chunks = [{"page_num": 14, "doc_title": "Redis", "content": "| A | B |", "chunk_type": "table"}]
        result = self._format_chunks(chunks)
        assert "第14页" in result
        assert "· table】" in result
        assert "Markdown表格" in result
        assert "行列关系" in result

    def test_figure_chunk_has_hint(self):
        chunks = [{"page_num": 8, "doc_title": "SysML", "content": "分类图...", "chunk_type": "figure"}]
        result = self._format_chunks(chunks)
        assert "第8页" in result
        assert "· figure】" in result
        assert "图片/流程图" in result
        assert "结构、分类、关系" in result

    def test_page_summary_chunk_has_hint(self):
        chunks = [{"page_num": 12, "doc_title": "Summary", "content": "摘要...", "chunk_type": "page_summary"}]
        result = self._format_chunks(chunks)
        assert "page_summary】" in result
        assert "页面摘要" in result

    def test_default_chunk_type_is_text(self):
        """Chunk without chunk_type field defaults to 'text'."""
        chunks = [{"page_num": 1, "doc_title": "Test", "content": "Hello"}]
        result = self._format_chunks(chunks)
        assert "· text】" in result

    def test_content_truncated_to_800_chars(self):
        long_content = "A" * 1000
        chunks = [{"page_num": 1, "doc_title": "Test", "content": long_content, "chunk_type": "text"}]
        result = self._format_chunks(chunks)
        assert "A" * 800 in result
        assert "A" * 801 not in result

    def test_multiple_chunks_separated(self):
        chunks = [
            {"page_num": 1, "doc_title": "A", "content": "Alpha", "chunk_type": "text"},
            {"page_num": 2, "doc_title": "B", "content": "Bravo", "chunk_type": "table"},
        ]
        result = self._format_chunks(chunks)
        assert "---" in result  # separator
        assert "Alpha" in result
        assert "Bravo" in result

    def test_max_5_chunks(self):
        chunks = [
            {"page_num": i, "doc_title": f"D{i}", "content": f"C{i}", "chunk_type": "text"}
            for i in range(1, 10)
        ]
        result = self._format_chunks(chunks)
        # Only first 5 should appear
        assert "C6" not in result
        assert "C1" in result


class TestSourcesFormatting:
    """Tests for the sources list formatting in ai_chat response."""

    @staticmethod
    def _format_sources(doc_chunks: list[dict]) -> list[dict]:
        """Replicate sources formatting from ai_chat."""
        if not doc_chunks:
            return []
        return [
            {
                'page_num': c.get('page_num'),
                'doc_title': c.get('doc_title', '文档'),
                'chunk_type': c.get('chunk_type', 'text'),
            }
            for c in doc_chunks[:5]
        ]

    def test_sources_include_chunk_type(self):
        chunks = [{"page_num": 14, "doc_title": "Redis", "chunk_type": "table"}]
        sources = self._format_sources(chunks)
        assert sources[0]["chunk_type"] == "table"

    def test_sources_default_chunk_type(self):
        chunks = [{"page_num": 1, "doc_title": "Doc"}]
        sources = self._format_sources(chunks)
        assert sources[0]["chunk_type"] == "text"

    def test_empty_chunks_empty_sources(self):
        assert self._format_sources([]) == []
