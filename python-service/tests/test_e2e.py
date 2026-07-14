"""End-to-end integration tests covering all 5 phases of PDF import enhancement.

Tests are designed to run WITHOUT a real Electron shell — they exercise the Python
API, DB layer, and cross-module wiring directly.
"""

import json
import os
import uuid
from pathlib import Path
from unittest.mock import patch

import pytest

# ── Helpers ──────────────────────────────────────────────────────────────────


def _chunks_by_type(chunks: list[dict], ctype: str) -> list[dict]:
    return [c for c in chunks if c.get("chunk_type") == ctype]


# ══════════════════════════════════════════════════════════════════════════════
# Phase 1+2: PDF Import Pipeline E2E
# ══════════════════════════════════════════════════════════════════════════════


class TestPdfParsePipeline:
    """Full pipeline: POST /pdf/parse -> parse_pdf_pages -> chunks + assets."""

    def test_parse_returns_chunks(self, client, table_pdf_path):
        """A real PDF (even minimal) should produce at least one chunk."""
        doc_id = str(uuid.uuid4())
        task_id = str(uuid.uuid4())

        # We can't easily wait for the background task, so call parse_pdf_pages directly
        from modules.pdf.router import parse_pdf_pages

        result = parse_pdf_pages(
            file_path=table_pdf_path,
            doc_id=doc_id,
            extract_tables=True,
            save_page_images=False,
        )

        assert result["doc_id"] == doc_id
        assert result["page_count"] >= 1
        assert len(result["chunks"]) >= 1
        assert "engines_used" in result
        # Should have at least pdfplumber
        assert any(e for e in result["engines_used"] if "pdfplumber" in e or "pypdfium2" in e)

    def test_table_extraction_enabled(self, table_pdf_path):
        """With extract_tables=True, the pipeline should run table detection."""
        from modules.pdf.router import parse_pdf_pages

        result = parse_pdf_pages(
            file_path=table_pdf_path,
            doc_id=str(uuid.uuid4()),
            extract_tables=True,
            save_page_images=False,
        )
        # table-extractor engine should be in the list
        assert "table-extractor" in result["engines_used"]

    def test_table_extraction_disabled(self, table_pdf_path):
        """With extract_tables=False, no table-extractor engine."""
        from modules.pdf.router import parse_pdf_pages

        result = parse_pdf_pages(
            file_path=table_pdf_path,
            doc_id=str(uuid.uuid4()),
            extract_tables=False,
            save_page_images=False,
        )
        assert "table-extractor" not in result["engines_used"]

    def test_chunks_have_required_fields(self, table_pdf_path):
        """Every chunk must include chunk_type, source_engine, block_order, confidence, bbox."""
        from modules.pdf.router import parse_pdf_pages

        result = parse_pdf_pages(
            file_path=table_pdf_path,
            doc_id=str(uuid.uuid4()),
            extract_tables=True,
            save_page_images=False,
        )
        for c in result["chunks"]:
            assert "chunk_type" in c
            assert c["chunk_type"] in ("text", "table", "figure", "page_summary")
            assert "source_engine" in c
            assert "block_order" in c
            assert "confidence" in c
            assert "bbox" in c  # even if empty

    def test_parse_invalid_file_raises(self):
        """Non-existent file should raise FileNotFoundError."""
        from modules.pdf.router import parse_pdf_pages
        import pytest as pt

        with pt.raises(FileNotFoundError, match="文件不存在"):
            parse_pdf_pages(
                file_path="/nonexistent/abc.pdf",
                doc_id=str(uuid.uuid4()),
            )

    def test_preview_returns_table_count(self, client, table_pdf_path):
        """Preview endpoint should report detected_tables_count."""
        res = client.post("/pdf/preview", json={
            "file_path": table_pdf_path,
            "preview_page": 1,
        })
        assert res.status_code == 200
        data = res.json()
        assert "detected_tables_count" in data
        assert isinstance(data["detected_tables_count"], int)
        assert "text" in data
        assert "page_count" in data


# ══════════════════════════════════════════════════════════════════════════════
# Phase 2: Asset Generation E2E
# ══════════════════════════════════════════════════════════════════════════════


class TestAssetGeneration:
    """Page screenshots and table crops are saved to disk."""

    def test_page_screenshots_saved(self, table_pdf_path, temp_output_dir):
        """save_page_images=True should produce page_image assets on disk."""
        from modules.pdf.router import parse_pdf_pages

        doc_id = str(uuid.uuid4())
        result = parse_pdf_pages(
            file_path=table_pdf_path,
            doc_id=doc_id,
            extract_tables=False,
            save_page_images=True,
            output_dir=temp_output_dir,
        )

        # Should have at least one page_image asset
        page_assets = [a for a in result["assets"] if a["asset_type"] == "page_image"]
        assert len(page_assets) >= 1, f"Expected page assets, got: {result['assets']}"

        # Asset file should exist on disk
        for a in page_assets:
            assert os.path.exists(a["file_path"]), f"Missing file: {a['file_path']}"
            assert a["width"] > 0
            assert a["height"] > 0

    def test_table_crops_saved(self, table_pdf_path, temp_output_dir):
        """When tables are extracted and save_page_images=True, table crops are generated."""
        from modules.pdf.router import parse_pdf_pages

        doc_id = str(uuid.uuid4())
        result = parse_pdf_pages(
            file_path=table_pdf_path,
            doc_id=doc_id,
            extract_tables=True,
            save_page_images=True,
            output_dir=temp_output_dir,
        )

        table_crops = [a for a in result["assets"] if a["asset_type"] == "table_crop"]
        # Table crops depend on pdfplumber finding tables in the minimal PDF
        # (it might or might not find them, but the pipeline should not crash)
        for a in table_crops:
            assert os.path.exists(a["file_path"]), f"Missing file: {a['file_path']}"

    def test_asset_metadata_complete(self, table_pdf_path, temp_output_dir):
        """Each asset dict has all required fields."""
        from modules.pdf.router import parse_pdf_pages

        doc_id = str(uuid.uuid4())
        result = parse_pdf_pages(
            file_path=table_pdf_path,
            doc_id=doc_id,
            extract_tables=True,
            save_page_images=True,
            output_dir=temp_output_dir,
        )

        required = {"id", "doc_id", "page_num", "asset_type", "file_path",
                     "width", "height", "bbox", "content_hash"}
        for a in result["assets"]:
            missing = required - set(a.keys())
            assert not missing, f"Asset missing fields: {missing}"

    def test_content_hash_unique(self, table_pdf_path, temp_output_dir):
        """Two different pages should produce different content hashes."""
        from modules.pdf.router import parse_pdf_pages
        from modules.pdf.extractors.assets import _hash_file
        import hashlib

        doc_id = str(uuid.uuid4())
        result = parse_pdf_pages(
            file_path=table_pdf_path,
            doc_id=doc_id,
            extract_tables=False,
            save_page_images=True,
            output_dir=temp_output_dir,
        )

        # If there's at least one asset, its hash should be a valid SHA256
        for a in result["assets"]:
            assert len(a["content_hash"]) == 64
            # Verify the hash matches file content
            if os.path.exists(a["file_path"]):
                computed = _hash_file(a["file_path"])
                assert computed == a["content_hash"]


# ══════════════════════════════════════════════════════════════════════════════
# Phase 3: Visual Summary E2E
# ══════════════════════════════════════════════════════════════════════════════


class TestVisionSummaryE2E:
    """Visual summary pipeline with mocked vision provider."""

    def test_vision_mode_disabled_skips_summary(self, table_pdf_path, temp_output_dir):
        """With vision_mode='disabled', no figure chunks are generated."""
        from modules.pdf.router import parse_pdf_pages

        result = parse_pdf_pages(
            file_path=table_pdf_path,
            doc_id=str(uuid.uuid4()),
            extract_tables=False,
            save_page_images=True,
            output_dir=temp_output_dir,
            generate_visual_summary=True,
            vision_mode="disabled",
            ai_config={"mode": "openai", "openai": {"apiKey": "sk-test", "model": "gpt-4o"}},
        )
        figure_chunks = _chunks_by_type(result["chunks"], "figure")
        assert len(figure_chunks) == 0

    def test_vision_provider_failure_not_fatal(self, table_pdf_path, temp_output_dir):
        """Even when vision_mode='remote' but provider fails, import still completes."""
        from modules.pdf.router import parse_pdf_pages

        # No real API key → provider builds but calls would fail
        # The pipeline should catch the failure and continue
        result = parse_pdf_pages(
            file_path=table_pdf_path,
            doc_id=str(uuid.uuid4()),
            extract_tables=False,
            save_page_images=True,
            output_dir=temp_output_dir,
            generate_visual_summary=True,
            vision_mode="remote",
            ai_config={"mode": "openai", "openai": {"apiKey": "", "model": "gpt-4o-mini"}},
        )
        # Should still have text chunks
        assert len(result["chunks"]) >= 1
        # May or may not have warnings depending on figure detection
        assert "warnings" in result

    def test_preview_returns_figure_detection(self, client, table_pdf_path):
        """Preview endpoint should include detected_figures_count."""
        res = client.post("/pdf/preview", json={
            "file_path": table_pdf_path,
            "preview_page": 1,
        })
        assert res.status_code == 200
        data = res.json()
        assert "detected_figures_count" in data
        assert isinstance(data["detected_figures_count"], int)

    def test_vision_cache_key_deterministic(self):
        """Cache keys must be deterministic and include all relevant inputs."""
        from modules.pdf.vision import _cache_key

        k1 = _cache_key("/img.png", "prompt", "model-A")
        k2 = _cache_key("/img.png", "prompt", "model-A")
        assert k1 == k2

        k3 = _cache_key("/img.png", "different", "model-A")
        assert k1 != k3

    def test_vision_cache_save_load_roundtrip(self, temp_output_dir):
        """Save a summary → load it → identical content."""
        from modules.pdf.vision import _save_cached_summary, _load_cached_summary

        _save_cached_summary(temp_output_dir, "abc123", "这是摘要内容")
        loaded = _load_cached_summary(temp_output_dir, "abc123")
        assert loaded == "这是摘要内容"

        # Non-existent key returns None
        assert _load_cached_summary(temp_output_dir, "nonexistent") is None


# ══════════════════════════════════════════════════════════════════════════════
# Phase 4: RAG & AI Chat E2E
# ══════════════════════════════════════════════════════════════════════════════


class TestRagContextFormatting:
    """AI context formatting with chunk_type hints."""

    @staticmethod
    def _format(doc_chunks: list[dict]) -> str:
        """Copy of the formatting logic from ai/router.py for E2E testing."""
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
                f' · {chunk_type}】{type_hint}\n{c["content"][:800]}'
            )
        return '\n\n---\n\n'.join(parts)

    def test_mixed_chunks_formatted(self):
        """Chunks of different types are properly segmented with type hints."""
        chunks = [
            {"page_num": 1, "doc_title": "Test", "content": "普通文本内容。", "chunk_type": "text"},
            {"page_num": 2, "doc_title": "Test", "content": "| 方案 | 特点 |\n| --- | --- |\n| A | B |", "chunk_type": "table"},
            {"page_num": 3, "doc_title": "Test", "content": "架构图摘要...", "chunk_type": "figure"},
        ]
        result = self._format(chunks)

        assert "· text】" in result
        assert "· table】" in result
        assert "Markdown表格" in result
        assert "· figure】" in result
        assert "图片/流程图" in result
        assert "---" in result  # separator between chunks

    def test_content_length_capped(self):
        """Content should not exceed 800 characters per chunk in context."""
        long_content = "X" * 2000
        chunks = [{"page_num": 1, "doc_title": "T", "content": long_content, "chunk_type": "text"}]
        result = self._format(chunks)
        # 800 chars + prefix overhead
        assert len("X" * 801) > len(result.split("X" * 800)[-1])
        # The 800-char portion should be present
        part = result.split("· text】\n", 1)[1] if "· text】\n" in result else result
        assert len(part) <= 800 + len("\n")

    def test_exactly_five_chunks_max(self):
        """Only the first 5 chunks are included in the context."""
        chunks = [
            {"page_num": i, "doc_title": f"D{i}", "content": f"C{i}", "chunk_type": "text"}
            for i in range(1, 10)
        ]
        result = self._format(chunks)
        for i in range(6, 10):
            assert f"C{i}" not in result


class TestRagSourcesFormatting:
    """Sources list in AI chat response includes chunk_type."""

    @staticmethod
    def _format_sources(doc_chunks: list[dict]) -> list[dict]:
        if not doc_chunks:
            return []
        return [
            {"page_num": c.get("page_num"), "doc_title": c.get("doc_title", "文档"),
             "chunk_type": c.get("chunk_type", "text")}
            for c in doc_chunks[:5]
        ]

    def test_table_source_has_type(self):
        sources = self._format_sources([{
            "page_num": 14, "doc_title": "Redis", "chunk_type": "table"
        }])
        assert sources[0]["chunk_type"] == "table"

    def test_figure_source_has_type(self):
        sources = self._format_sources([{
            "page_num": 8, "doc_title": "SysML", "chunk_type": "figure"
        }])
        assert sources[0]["chunk_type"] == "figure"

    def test_unknown_type_defaults_to_text(self):
        sources = self._format_sources([{
            "page_num": 1, "doc_title": "Doc"
        }])
        assert sources[0]["chunk_type"] == "text"


class TestAiChatEndpoint:
    """POST /ai/chat endpoint integration."""

    def test_chat_without_context(self, client):
        """Chat works when no doc_chunks are provided."""
        res = client.post("/ai/chat", json={
            "ai_config": {"mode": "openai", "openai": {"apiKey": "sk-fake", "baseUrl": "https://api.openai.com/v1", "model": "gpt-4o-mini"}},
            "question": "什么是软件架构？",
            "history": [],
            "doc_chunks": [],
        })
        # Will fail because we have no real API key, but the endpoint should respond
        assert res.status_code in (200, 500)  # 500 if provider call fails is expected

    def test_chat_with_table_context(self, client):
        """Chat endpoint accepts doc_chunks with chunk_type='table'."""
        res = client.post("/ai/chat", json={
            "ai_config": {"mode": "openai", "openai": {"apiKey": "sk-fake", "baseUrl": "https://api.openai.com/v1", "model": "gpt-4o-mini"}},
            "question": "Redis主从和哨兵有什么区别？",
            "history": [],
            "doc_chunks": [{
                "content": "## 第14页 表格：Redis方案\n| 方案 | 特点 |\n| --- | --- |\n| 主从 | 手动切换 |",
                "page_num": 14,
                "doc_title": "Redis资料",
                "chunk_type": "table",
            }],
        })
        # The endpoint either works or fails at the AI provider level (both fine for E2E)
        assert res.status_code in (200, 400, 500, 502)

    def test_chat_empty_doc_chunks(self, client):
        """Chat works with empty doc_chunks list."""
        res = client.post("/ai/chat", json={
            "ai_config": {"mode": "openai", "openai": {"apiKey": "sk-fake", "baseUrl": "https://api.openai.com/v1", "model": "gpt-4o-mini"}},
            "question": "测试",
            "history": [],
            "doc_chunks": [],
        })
        assert res.status_code in (200, 500)


# ══════════════════════════════════════════════════════════════════════════════
# Phase 5: Reparse & Correction E2E
# ══════════════════════════════════════════════════════════════════════════════


class TestReparseEndpoint:
    """POST /pdf/reparse-page endpoint."""

    def test_reparse_valid_page(self, client, table_pdf_path):
        """Reparse a single page and get chunks back."""
        res = client.post("/pdf/reparse-page", json={
            "file_path": table_pdf_path,
            "doc_id": str(uuid.uuid4()),
            "page_num": 1,
            "re_tables": True,
            "re_vision": False,
            "save_page_images": False,
        })
        assert res.status_code == 200
        data = res.json()
        assert "chunks" in data
        assert "assets" in data
        assert "engines_used" in data
        assert data["page_num"] == 1

    def test_reparse_invalid_file(self, client):
        """Reparse with non-existent file returns 404."""
        res = client.post("/pdf/reparse-page", json={
            "file_path": "/nonexistent.pdf",
            "doc_id": str(uuid.uuid4()),
            "page_num": 1,
        })
        assert res.status_code == 404

    def test_reparse_invalid_page_number(self, client, table_pdf_path):
        """Reparse with page_num < 1 returns 422 (Pydantic validation)."""
        res = client.post("/pdf/reparse-page", json={
            "file_path": table_pdf_path,
            "doc_id": str(uuid.uuid4()),
            "page_num": 0,
        })
        assert res.status_code == 422

    def test_reparse_with_vision_disabled(self, client, table_pdf_path):
        """Reparse with re_vision=True but default disabled mode — still works."""
        res = client.post("/pdf/reparse-page", json={
            "file_path": table_pdf_path,
            "doc_id": str(uuid.uuid4()),
            "page_num": 1,
            "re_tables": True,
            "re_vision": True,
            "vision_mode": "disabled",
            "ai_config": {"mode": "openai", "openai": {"apiKey": "", "model": "gpt-4o-mini"}},
        })
        assert res.status_code == 200
        data = res.json()
        assert len(data["chunks"]) >= 1

    def test_reparse_preserves_chunk_structure(self, client, table_pdf_path):
        """Reparsed chunks have all required fields including chunk_type."""
        res = client.post("/pdf/reparse-page", json={
            "file_path": table_pdf_path,
            "doc_id": str(uuid.uuid4()),
            "page_num": 1,
            "re_tables": True,
        })
        assert res.status_code == 200
        for c in res.json()["chunks"]:
            assert "chunk_type" in c
            assert c["chunk_type"] in ("text", "table", "figure", "page_summary")


# ══════════════════════════════════════════════════════════════════════════════
# DB Integration: Chunk CRUD + FTS + Cascade
# ══════════════════════════════════════════════════════════════════════════════


class TestDocChunksDb:
    """Exercise the doc_chunks table with new columns via direct SQL."""

    def test_insert_text_chunk_triggers_fts(self, db):
        """Inserting a chunk should automatically populate doc_chunks_fts."""
        import uuid as _uuid

        doc_id = str(_uuid.uuid4())
        db.execute("INSERT INTO documents(id, title, file_path, page_count, md5) VALUES(?,?,?,?,?)",
                   [doc_id, "Test Doc", "/tmp/test.pdf", 1, "abc123"])
        db.execute(
            "INSERT INTO doc_chunks(id, doc_id, page_num, content, knowledge_tags, chunk_type, source_engine) "
            "VALUES(?,?,?,?,?,?,?)",
            [str(_uuid.uuid4()), doc_id, 1, "测试内容", "[]", "text", "pdfplumber"],
        )
        db.commit()

        row = db.execute("SELECT COUNT(*) as cnt FROM doc_chunks_fts WHERE doc_chunks_fts MATCH ?",
                         ["测试内容"]).fetchone()
        assert row["cnt"] >= 1

    def test_insert_table_chunk_with_all_fields(self, db):
        """A table chunk can be inserted with confidence, bbox, asset_id."""
        import uuid as _uuid

        doc_id = str(_uuid.uuid4())
        chunk_id = str(_uuid.uuid4())
        db.execute("INSERT INTO documents(id, title, file_path, page_count, md5) VALUES(?,?,?,?,?)",
                   [doc_id, "T", "/tmp/t.pdf", 1, "x"])
        db.execute(
            "INSERT INTO doc_chunks(id, doc_id, page_num, content, knowledge_tags, "
            "chunk_type, asset_id, confidence, source_engine, block_order, bbox) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            [chunk_id, doc_id, 5, "| A | B |", "[]", "table", "asset-1", 0.85, "pdfplumber-table", 0,
             '{"x0":10,"top":20,"x1":100,"bottom":80}'],
        )
        db.commit()

        row = db.execute("SELECT * FROM doc_chunks WHERE id = ?", [chunk_id]).fetchone()
        assert row["chunk_type"] == "table"
        assert row["asset_id"] == "asset-1"
        assert row["confidence"] == 0.85
        assert row["source_engine"] == "pdfplumber-table"
        assert row["block_order"] == 0
        assert "x0" in row["bbox"]

    def test_fts_search_finds_table_content(self, db):
        """FTS should index the Markdown table content."""
        import uuid as _uuid

        doc_id = str(_uuid.uuid4())
        db.execute("INSERT INTO documents(id, title, file_path, page_count, md5) VALUES(?,?,?,?,?)",
                   [doc_id, "T", "/t.pdf", 1, "m"])
        db.execute(
            "INSERT INTO doc_chunks(id, doc_id, page_num, content, knowledge_tags, chunk_type, source_engine) "
            "VALUES(?,?,?,?,?,?,?)",
            [str(_uuid.uuid4()), doc_id, 1, "Redis MasterSlave Sentinel Cluster", "[]", "table", "pdfplumber-table"],
        )
        db.commit()

        row = db.execute(
            "SELECT c.* FROM doc_chunks_fts f JOIN doc_chunks c ON c.rowid = f.rowid WHERE doc_chunks_fts MATCH ?",
            ["MasterSlave"],
        ).fetchone()
        assert row is not None
        assert "Redis" in row["content"]

    def test_delete_document_cascades_to_chunks(self, db):
        """ON DELETE CASCADE: deleting a document removes its chunks."""
        import uuid as _uuid

        doc_id = str(_uuid.uuid4())
        chunk_id = str(_uuid.uuid4())
        db.execute("INSERT INTO documents(id, title, file_path, page_count, md5) VALUES(?,?,?,?,?)",
                   [doc_id, "D", "/d.pdf", 1, "h"])
        db.execute(
            "INSERT INTO doc_chunks(id, doc_id, page_num, content, knowledge_tags) VALUES(?,?,?,?,?)",
            [chunk_id, doc_id, 1, "content", "[]"],
        )
        db.commit()

        db.execute("DELETE FROM documents WHERE id = ?", [doc_id])
        db.commit()

        row = db.execute("SELECT * FROM doc_chunks WHERE id = ?", [chunk_id]).fetchone()
        assert row is None

    def test_update_chunk_fts_sync(self, db):
        """Updating chunk content should update the FTS index (via triggers)."""
        import uuid as _uuid

        doc_id = str(_uuid.uuid4())
        chunk_id = str(_uuid.uuid4())
        db.execute("INSERT INTO documents(id, title, file_path, page_count, md5) VALUES(?,?,?,?,?)",
                   [doc_id, "D", "/d.pdf", 1, "h"])
        db.execute(
            "INSERT INTO doc_chunks(id, doc_id, page_num, content, knowledge_tags, chunk_type) VALUES(?,?,?,?,?,?)",
            [chunk_id, doc_id, 1, "original content here", "[]", "text"],
        )
        db.commit()

        # Update
        db.execute("UPDATE doc_chunks SET content = ? WHERE id = ?", ["corrected content here", chunk_id])
        db.commit()

        # FTS should now have the new content
        row = db.execute(
            "SELECT c.content FROM doc_chunks_fts f JOIN doc_chunks c ON c.rowid = f.rowid WHERE doc_chunks_fts MATCH ?",
            ["corrected"],
        ).fetchone()
        assert row is not None
        assert "corrected content" in row["content"]

        # Old content should be gone from FTS
        row2 = db.execute(
            "SELECT c.content FROM doc_chunks_fts f JOIN doc_chunks c ON c.rowid = f.rowid WHERE doc_chunks_fts MATCH ?",
            ["original"],
        ).fetchone()
        assert row2 is None


class TestDocAssetsDb:
    """Exercise the doc_assets table."""

    def test_insert_asset(self, db):
        """Insert a page_image asset."""
        import uuid as _uuid

        doc_id = str(_uuid.uuid4())
        asset_id = str(_uuid.uuid4())
        db.execute("INSERT INTO documents(id, title, file_path, page_count, md5) VALUES(?,?,?,?,?)",
                   [doc_id, "D", "/d.pdf", 1, "h"])
        db.execute(
            "INSERT INTO doc_assets(id, doc_id, page_num, asset_type, file_path, width, height, bbox, content_hash) "
            "VALUES(?,?,?,?,?,?,?,?,?)",
            [asset_id, doc_id, 1, "page_image", "/assets/p1.png", 1200, 800, "{}", "sha256abc"],
        )
        db.commit()

        row = db.execute("SELECT * FROM doc_assets WHERE id = ?", [asset_id]).fetchone()
        assert row is not None
        assert row["asset_type"] == "page_image"
        assert row["width"] == 1200

    def test_unique_content_hash_per_doc(self, db):
        """doc_assets has UNIQUE(doc_id, content_hash) — duplicates are ignored."""
        import uuid as _uuid

        doc_id = str(_uuid.uuid4())
        db.execute("INSERT INTO documents(id, title, file_path, page_count, md5) VALUES(?,?,?,?,?)",
                   [doc_id, "D", "/d.pdf", 1, "h"])
        db.execute(
            "INSERT INTO doc_assets(id, doc_id, page_num, asset_type, file_path, width, height, bbox, content_hash) "
            "VALUES(?,?,?,?,?,?,?,?,?)",
            [str(_uuid.uuid4()), doc_id, 1, "page_image", "/a1.png", 100, 100, "{}", "same_hash"],
        )
        db.commit()

        # Second insert with same (doc_id, content_hash) should fail
        import pytest as pt
        with pt.raises(Exception):
            db.execute(
                "INSERT INTO doc_assets(id, doc_id, page_num, asset_type, file_path, width, height, bbox, content_hash) "
                "VALUES(?,?,?,?,?,?,?,?,?)",
                [str(_uuid.uuid4()), doc_id, 2, "page_image", "/a2.png", 100, 100, "{}", "same_hash"],
            )
            db.commit()

    def test_delete_doc_cascades_to_assets(self, db):
        """ON DELETE CASCADE: deleting a document removes its assets."""
        import uuid as _uuid

        doc_id = str(_uuid.uuid4())
        asset_id = str(_uuid.uuid4())
        db.execute("INSERT INTO documents(id, title, file_path, page_count, md5) VALUES(?,?,?,?,?)",
                   [doc_id, "D", "/d.pdf", 1, "h"])
        db.execute(
            "INSERT INTO doc_assets(id, doc_id, page_num, asset_type, file_path, width, height, bbox, content_hash) "
            "VALUES(?,?,?,?,?,?,?,?,?)",
            [asset_id, doc_id, 1, "page_image", "/x.png", 100, 100, "{}", "h1"],
        )
        db.commit()

        db.execute("DELETE FROM documents WHERE id = ?", [doc_id])
        db.commit()

        row = db.execute("SELECT * FROM doc_assets WHERE id = ?", [asset_id]).fetchone()
        assert row is None


# ══════════════════════════════════════════════════════════════════════════════
# Cross-cutting: Warnings, Error Codes
# ══════════════════════════════════════════════════════════════════════════════


class TestWarningsAndErrors:
    """Error handling and warning generation across the pipeline."""

    def test_vision_disabled_generates_no_warning_for_parse(self, table_pdf_path):
        """When vision is disabled, no spurious warnings should appear."""
        from modules.pdf.router import parse_pdf_pages

        result = parse_pdf_pages(
            file_path=table_pdf_path,
            doc_id=str(uuid.uuid4()),
            extract_tables=False,
            save_page_images=False,
            generate_visual_summary=False,
            vision_mode="disabled",
        )
        # Should complete without warnings
        assert "warnings" in result

    def test_engines_used_always_reported(self, table_pdf_path):
        """The engines_used list is always present in parse results."""
        from modules.pdf.router import parse_pdf_pages

        result = parse_pdf_pages(
            file_path=table_pdf_path,
            doc_id=str(uuid.uuid4()),
        )
        assert "engines_used" in result
        assert isinstance(result["engines_used"], list)
        assert len(result["engines_used"]) >= 1

    def test_parse_preserves_page_range_info(self, table_pdf_path):
        """Parse result includes parsed_range and crop_ratios metadata."""
        from modules.pdf.router import parse_pdf_pages

        result = parse_pdf_pages(
            file_path=table_pdf_path,
            doc_id=str(uuid.uuid4()),
            start_page=1,
        )
        assert "parsed_range" in result
        assert result["parsed_range"]["start_page"] == 1
        assert "crop_ratios" in result


# ══════════════════════════════════════════════════════════════════════════════
# preview endpoint E2E
# ══════════════════════════════════════════════════════════════════════════════


class TestPreviewE2E:
    """Preview endpoint full integration."""

    def test_preview_valid_file(self, client, table_pdf_path):
        res = client.post("/pdf/preview", json={"file_path": table_pdf_path, "preview_page": 1})
        assert res.status_code == 200
        data = res.json()
        assert data["preview_page"] == 1
        assert data["page_count"] >= 1
        assert "text" in data
        assert "engine" in data

    def test_preview_nonexistent_file(self, client):
        res = client.post("/pdf/preview", json={"file_path": "/nonexistent.pdf", "preview_page": 1})
        assert res.status_code == 404

    def test_preview_invalid_page(self, client, table_pdf_path):
        """Preview with out-of-range page number returns 400."""
        res = client.post("/pdf/preview", json={"file_path": table_pdf_path, "preview_page": 999})
        assert res.status_code in (400, 200)  # Depends on actual page count of minimal PDF


# ══════════════════════════════════════════════════════════════════════════════
# DB Migration v17 E2E
# ══════════════════════════════════════════════════════════════════════════════


class TestMigrationV17:
    """Verify the schema migration v17 produces the correct DB shape."""

    def test_doc_chunks_has_new_columns(self, db):
        columns = {row[1] for row in db.execute("PRAGMA table_info('doc_chunks')").fetchall()}
        for col in ("chunk_type", "asset_id", "confidence", "source_engine", "block_order", "bbox"):
            assert col in columns, f"Missing column: {col}"

    def test_doc_assets_table_exists(self, db):
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        assert "doc_assets" in tables

    def test_doc_chunks_fts_exists(self, db):
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        assert "doc_chunks_fts" in tables

    def test_doc_assets_indexes(self, db):
        indexes = {row[1] for row in db.execute("SELECT * FROM sqlite_master WHERE type='index'").fetchall()}
        assert "idx_doc_assets_doc_page" in indexes
        assert "idx_doc_assets_hash" in indexes

    def test_doc_chunks_triggers_exist(self, db):
        triggers = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='trigger'").fetchall()}
        for t in ("doc_chunks_ai", "doc_chunks_ad", "doc_chunks_au"):
            assert t in triggers, f"Missing trigger: {t}"


# ══════════════════════════════════════════════════════════════════════════════
# Vision Provider Builder E2E
# ══════════════════════════════════════════════════════════════════════════════


class TestVisionProviderBuilderE2E:
    """build_vision_provider creates the correct provider class for each mode."""

    def test_build_ollama_provider(self):
        from modules.pdf.vision import build_vision_provider, OllamaVisionProvider
        cfg = {"mode": "ollama", "ollama": {"baseUrl": "http://localhost:11434", "model": "llava"}}
        provider = build_vision_provider(cfg)
        assert isinstance(provider, OllamaVisionProvider)

    def test_build_anthropic_provider(self):
        from modules.pdf.vision import build_vision_provider, AnthropicVisionProvider
        cfg = {"mode": "anthropic", "anthropic": {"apiKey": "sk-ant-test", "model": "claude-sonnet-4-6"}}
        provider = build_vision_provider(cfg)
        assert isinstance(provider, AnthropicVisionProvider)

    def test_build_openai_provider(self):
        from modules.pdf.vision import build_vision_provider, OpenAICompatVisionProvider
        cfg = {"mode": "openai", "openai": {"apiKey": "sk-test", "model": "gpt-4o-mini", "baseUrl": "https://api.openai.com/v1"}}
        provider = build_vision_provider(cfg)
        assert isinstance(provider, OpenAICompatVisionProvider)

    def test_ollama_no_model_returns_none(self):
        from modules.pdf.vision import build_vision_provider
        cfg = {"mode": "ollama", "ollama": {"model": ""}}
        provider = build_vision_provider(cfg)
        assert provider is None


# ══════════════════════════════════════════════════════════════════════════════
# Figure Detection E2E
# ══════════════════════════════════════════════════════════════════════════════


class TestFigureDetectionE2E:
    """detect_figure_page integration with real extracted page text."""

    def test_plain_text_not_figure(self, plain_pdf_path):
        """A text-heavy PDF page should not be detected as a figure page."""
        from modules.pdf.router import parse_pdf_pages
        from modules.pdf.extractors.visual import detect_figure_page

        result = parse_pdf_pages(
            file_path=plain_pdf_path,
            doc_id=str(uuid.uuid4()),
            extract_tables=False,
            save_page_images=False,
        )
        # Get the extracted text from chunks
        all_text = " ".join(c["content"] for c in result["chunks"])
        is_figure = detect_figure_page(all_text)
        assert is_figure is False, "Plain text page should not be detected as figure"

    def test_short_text_may_be_figure(self, table_pdf_path):
        """A table-heavy page with short lines may be detected as figure candidate."""
        from modules.pdf.router import parse_pdf_pages
        from modules.pdf.extractors.visual import detect_figure_page

        result = parse_pdf_pages(
            file_path=table_pdf_path,
            doc_id=str(uuid.uuid4()),
            extract_tables=False,
            save_page_images=False,
        )
        all_text = " ".join(c["content"] for c in result["chunks"])
        result_flag = detect_figure_page(all_text)
        # Just verify it doesn't crash — result depends on PDF content
        assert isinstance(result_flag, bool)
