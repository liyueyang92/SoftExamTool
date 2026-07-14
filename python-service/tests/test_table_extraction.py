"""Unit tests for PDF table extraction and markdown conversion."""

import sys
from pathlib import Path

# Add modules path to sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from modules.pdf.extractors.tables import _clean_table, _to_markdown, _table_bbox


class TestCleanTable:
    """Tests for _clean_table cell normalization."""

    def test_removes_none_cells(self):
        raw = [["Header1", "Header2"], ["value1", None]]
        result = _clean_table(raw)
        assert result == [["Header1", "Header2"], ["value1", ""]]

    def test_collapses_whitespace(self):
        raw = [["  Hello   world  ", "  foo\nbar  "]]
        result = _clean_table(raw)
        assert result == [["Hello world", "foo bar"]]

    def test_removes_fully_empty_rows(self):
        raw = [["Header1", "Header2"], ["", None], ["val1", "val2"]]
        result = _clean_table(raw)
        assert len(result) == 2
        assert result[0] == ["Header1", "Header2"]
        assert result[1] == ["val1", "val2"]

    def test_preserves_empty_cells_in_data_rows(self):
        raw = [["Col1", "Col2"], ["val1", ""]]
        result = _clean_table(raw)
        assert result == [["Col1", "Col2"], ["val1", ""]]

    def test_handles_newlines_in_cells(self):
        raw = [["Cell\nwith\nnewlines", "normal"]]
        result = _clean_table(raw)
        assert result == [["Cell with newlines", "normal"]]


class TestToMarkdown:
    """Tests for _to_markdown conversion."""

    def test_basic_table(self):
        rows = [["Name", "Value"], ["foo", "bar"], ["baz", "qux"]]
        md = _to_markdown(rows, page_num=1, table_index=1)
        assert md.startswith("## 第 1 页 表格：")
        assert "| Name | Value |" in md
        assert "| --- | --- |" in md
        assert "| foo | bar |" in md
        assert "| baz | qux |" in md

    def test_rejects_single_column(self):
        rows = [["single"], ["col"]]
        md = _to_markdown(rows, page_num=1, table_index=1)
        assert md == ""

    def test_rejects_empty_input(self):
        md = _to_markdown([], page_num=1, table_index=1)
        assert md == ""

    def test_pads_short_rows(self):
        """Rows with fewer columns should be padded to match widest row."""
        rows = [["A", "B", "C"], ["x", "y"]]
        md = _to_markdown(rows, page_num=2, table_index=2)
        # Should have 3 columns in each row
        lines = md.split("\n")
        data_lines = [l for l in lines if l.startswith("|")]
        for line in data_lines:
            # Each pipe line should have 3 cells (3 pipes before the trailing pipe)
            parts = line.strip("|").split("|")
            assert len(parts) == 3, f"Expected 3 columns, got {len(parts)} in: {line}"

    def test_title_uses_page_and_table_index(self):
        rows = [["X", "Y"], ["1", "2"]]
        md = _to_markdown(rows, page_num=42, table_index=3)
        assert "第 42 页 表格" in md

    def test_title_uses_header_text(self):
        rows = [["方案名称", "核心特点"], ["A", "B"]]
        md = _to_markdown(rows, page_num=1, table_index=1)
        assert "方案名称" in md


class TestTableBbox:
    """Tests for _table_bbox extraction."""

    def test_valid_bbox(self):
        class FakeTable:
            bbox = (10.5, 20.3, 700.8, 500.1)

        bbox = _table_bbox(FakeTable())
        assert bbox == {"x0": 10.5, "top": 20.3, "x1": 700.8, "bottom": 500.1}

    def test_missing_bbox(self):
        class FakeTable:
            pass

        bbox = _table_bbox(FakeTable())
        assert bbox == {}
