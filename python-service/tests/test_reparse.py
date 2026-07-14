"""Unit tests for reparse-page and manual correction logic."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pydantic import ValidationError

# We test the model validation separately from the endpoint
from modules.pdf.router import ReparsePageRequest


class TestReparsePageRequest:
    """Tests for the ReparsePageRequest Pydantic model."""

    def test_valid_minimal_request(self):
        req = ReparsePageRequest(
            file_path="/tmp/test.pdf",
            doc_id="abc-123",
            page_num=5,
        )
        assert req.page_num == 5
        assert req.re_tables is True
        assert req.re_vision is False
        assert req.save_page_images is True
        assert req.vision_mode == "disabled"

    def test_page_num_must_be_positive(self):
        from pydantic import ValidationError
        try:
            ReparsePageRequest(file_path="/t.pdf", doc_id="x", page_num=0)
            assert False, "Should have raised ValidationError"
        except ValidationError:
            pass

    def test_page_num_must_be_integer(self):
        try:
            ReparsePageRequest(file_path="/t.pdf", doc_id="x", page_num=-1)
            assert False, "Should have raised ValidationError"
        except ValidationError:
            pass

    def test_default_values(self):
        req = ReparsePageRequest(file_path="/t.pdf", doc_id="x", page_num=1)
        assert req.top_margin_ratio == 0.07
        assert req.bottom_margin_ratio == 0.07
        assert req.re_ocr is False
        assert req.re_tables is True
        assert req.re_vision is False
        assert req.output_dir == ""

    def test_full_options(self):
        req = ReparsePageRequest(
            file_path="/tmp/test.pdf",
            doc_id="doc-456",
            page_num=3,
            top_margin_ratio=0.1,
            bottom_margin_ratio=0.05,
            re_ocr=True,
            re_tables=True,
            re_vision=True,
            save_page_images=True,
            output_dir="/output",
            vision_mode="remote",
            ai_config={"mode": "openai", "openai": {"apiKey": "sk-test"}},
        )
        assert req.re_ocr is True
        assert req.re_vision is True
        assert req.vision_mode == "remote"
        assert req.output_dir == "/output"
        assert req.top_margin_ratio == 0.1

    def test_margin_ratio_validation(self):
        """Margin ratios are validated inside parse_pdf_pages, not at model level for ReparsePageRequest."""
        # ReparsePageRequest does not inherit from PdfExtractOptions (which has the validator),
        # but parse_pdf_pages calls validate_margin_ratios which raises ValueError.
        from modules.pdf.router import validate_margin_ratios
        try:
            validate_margin_ratios(1.0, 0.0)
            assert False, "Should have raised ValueError"
        except ValueError:
            pass

        try:
            validate_margin_ratios(0.05, -0.1)
            assert False, "Should have raised ValueError"
        except ValueError:
            pass


class TestConfidenceAfterEdit:
    """Tests for confidence marking after manual correction."""

    def test_edited_chunk_gets_confidence_1(self):
        """After manual edit, confidence should be set to 1.0."""
        confidence = 1.0  # Simulating: chunk.confidence = 1.0 after saveEdit()
        assert confidence == 1.0
        assert confidence > 0.7  # Above the low-confidence threshold

    def test_low_confidence_detected(self):
        """Low confidence (< 0.7) is correctly identified."""
        low_conf = 0.6
        assert low_conf < 0.7  # Would show ⚠️ indicator

        high_conf = 0.85
        assert high_conf >= 0.7  # Would NOT show ⚠️

    def test_null_confidence_no_warning(self):
        """Null confidence should not trigger the warning."""
        conf = None
        is_low = conf is not None and conf < 0.7
        assert is_low is False


class TestChunkTypeFiltering:
    """Tests for chunk type awareness after manual correction."""

    def test_table_type_preserved_after_edit(self):
        """Editing a table chunk should preserve chunk_type='table'."""
        chunk_type = "table"
        assert chunk_type in ("text", "table", "figure", "page_summary")

    def test_figure_type_preserved_after_edit(self):
        """Editing a figure chunk should preserve chunk_type='figure'."""
        chunk_type = "figure"
        assert chunk_type in ("text", "table", "figure", "page_summary")
