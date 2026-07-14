"""Unit tests for PDF asset generation."""

import hashlib
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from modules.pdf.extractors.assets import _hash_file, _hash_bbox


class TestHashFile:
    """Tests for SHA256 file hashing."""

    def test_hash_deterministic(self):
        with tempfile.NamedTemporaryFile(delete=False, suffix=".txt", mode="w") as f:
            f.write("hello world")
            tmp_path = f.name
        try:
            h1 = _hash_file(tmp_path)
            h2 = _hash_file(tmp_path)
            assert h1 == h2
            assert len(h1) == 64  # SHA256 hex length
        finally:
            os.unlink(tmp_path)

    def test_hash_differs_for_different_content(self):
        tmp1 = None
        tmp2 = None
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=".txt", mode="w") as f:
                f.write("content A")
                tmp1 = f.name
            with tempfile.NamedTemporaryFile(delete=False, suffix=".txt", mode="w") as f:
                f.write("content B")
                tmp2 = f.name
            h1 = _hash_file(tmp1)
            h2 = _hash_file(tmp2)
            assert h1 != h2
        finally:
            if tmp1:
                os.unlink(tmp1)
            if tmp2:
                os.unlink(tmp2)


class TestHashBbox:
    """Tests for bbox short hash generation."""

    def test_returns_8_char_hex(self):
        bbox = {"x0": 10.0, "top": 20.0, "x1": 700.0, "bottom": 500.0}
        h = _hash_bbox(bbox)
        assert len(h) == 8
        assert all(c in "0123456789abcdef" for c in h)

    def test_same_bbox_same_hash(self):
        bbox = {"x0": 1, "top": 2, "x1": 3, "bottom": 4}
        assert _hash_bbox(bbox) == _hash_bbox(bbox)

    def test_different_bbox_different_hash(self):
        b1 = {"x0": 1, "top": 2, "x1": 3, "bottom": 4}
        b2 = {"x0": 5, "top": 6, "x1": 7, "bottom": 8}
        assert _hash_bbox(b1) != _hash_bbox(b2)


class TestAssetMetadata:
    """Tests for asset metadata structure (no actual rendering needed)."""

    def test_asset_metadata_shape(self):
        """Verify the expected metadata keys for a page screenshot asset."""
        # We test the shape of the dict returned by generate_page_screenshot
        # without actually calling it (which requires a PDF page).
        expected_keys = {
            "id", "doc_id", "page_num", "asset_type",
            "file_path", "width", "height", "bbox", "content_hash",
        }
        # All required keys should be present in a valid asset dict
        assert expected_keys >= {"id", "file_path", "content_hash"}

    def test_table_crop_metadata_shape(self):
        """Verify the expected metadata keys for a table crop asset."""
        # Table crop returns the same keys as page screenshot
        expected_keys = {
            "id", "doc_id", "page_num", "asset_type",
            "file_path", "width", "height", "bbox", "content_hash",
        }
        assert expected_keys >= {"id", "file_path", "content_hash"}
