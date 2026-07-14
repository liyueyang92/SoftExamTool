"""E2E integration tests — shared fixtures: temp PDFs, TestClient, in-memory DB."""

import os
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

# Ensure the python-service root is importable
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


# ── PDF generator (via fpdf2) ────────────────────────────────────────────────

def _build_pdf(text_lines: list[str]) -> bytes:
    """Build a valid single-page PDF with given text lines."""
    try:
        from fpdf import FPDF
    except ImportError:
        # Fallback to raw bytes if fpdf2 not available (shouldn't happen in CI)
        return _build_minimal_pdf_fallback(text_lines)

    pdf = FPDF()
    pdf.add_page()
    pdf.set_font("Helvetica", size=12)
    # Register a Unicode-capable font path if needed, else use ASCII-safe
    for line in text_lines:
        safe = line.encode("latin-1", errors="replace").decode("latin-1")
        pdf.cell(0, 8, text=safe, new_x="LMARGIN", new_y="NEXT")
    return pdf.output()


def _build_minimal_pdf_fallback(text_lines: list[str]) -> bytes:
    """Last-resort minimal PDF bytes (pdfplumber-compatible)."""
    lines = list(text_lines)
    content_parts = ["BT"]
    y = 700
    for line in lines:
        safe = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        content_parts.append(f"/F1 12 Tf 72 {y} Td ({safe}) Tj")
        y -= 18
    content_parts.append("ET")
    content_stream = "\n".join(content_parts)

    objs = [
        "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
        "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
        "3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 4 0 R/Resources<</Font<</F1<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>>>>>>>endobj",
        f"4 0 obj<</Length {len(content_stream)}>>stream\n{content_stream}\nendstream\nendobj",
    ]
    header = "%PDF-1.4\n"
    body = "\n".join(objs) + "\n"

    # Compute xref offsets
    offsets = []
    pos = len(header)
    for obj in objs:
        offsets.append(pos)
        pos += len(obj) + 1
    xref_offset = pos

    xref = "xref\n0 5\n0000000000 65535 f \n"
    for off in offsets:
        xref += f"{off:010d} 00000 n \n"
    trailer = f"trailer<</Size 5/Root 1 0 R>>\nstartxref\n{xref_offset}\n%%EOF"

    return (header + body + xref + trailer).encode("latin-1", errors="replace")


def build_table_pdf_bytes() -> bytes:
    return _build_pdf([
        "Redis Distributed Storage Comparison",
        "Scheme           Key Feature",
        "Master-Slave     Manual failover",
        "Sentinel         Auto failover with sentinel",
        "Cluster          Peer-to-peer, slot-based sharding",
    ])


def build_plain_text_pdf_bytes() -> bytes:
    return _build_pdf([
        "Chapter 1 Software Architecture Design Overview",
        "Software architecture design is a critical phase in system development.",
        "Architecture design must satisfy functional requirements while also",
        "considering system performance, availability, security, and modifiability.",
        "Architects must make trade-offs across multiple dimensions and select",
        "appropriate architectural styles and design patterns for the project.",
    ])


@pytest.fixture
def table_pdf_path() -> str:
    tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
    tmp.write(build_table_pdf_bytes())
    tmp.close()
    yield tmp.name
    try:
        os.unlink(tmp.name)
    except OSError:
        pass


@pytest.fixture
def plain_pdf_path() -> str:
    tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
    tmp.write(build_plain_text_pdf_bytes())
    tmp.close()
    yield tmp.name
    try:
        os.unlink(tmp.name)
    except OSError:
        pass


@pytest.fixture
def temp_output_dir() -> str:
    d = tempfile.mkdtemp()
    yield d
    try:
        shutil.rmtree(d)
    except OSError:
        pass


# ── In-memory SQLite DB with schema ─────────────────────────────────────────

def _exec_sql_block(conn, sql_block: str) -> None:
    """Execute a multi-statement SQL block using executescript."""
    # executescript needs separate connection; we use it on the same conn
    conn.executescript(sql_block)


@pytest.fixture
def db():
    """In-memory SQLite database with full schema (v1 + v17 migrations)."""
    import sqlite3

    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")

    # v1 — core tables
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS documents (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, file_path TEXT NOT NULL,
          page_count INTEGER NOT NULL DEFAULT 0, md5 TEXT NOT NULL,
          imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE TABLE IF NOT EXISTS doc_chunks (
          id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          page_num INTEGER NOT NULL, content TEXT NOT NULL,
          knowledge_tags TEXT NOT NULL DEFAULT '[]', vector_id TEXT
        );
    """)

    # v17 — extension columns + FTS + doc_assets
    conn.executescript("""
        ALTER TABLE doc_chunks ADD COLUMN chunk_type TEXT NOT NULL DEFAULT 'text'
          CHECK(chunk_type IN ('text','table','figure','page_summary'));
        ALTER TABLE doc_chunks ADD COLUMN asset_id TEXT;
        ALTER TABLE doc_chunks ADD COLUMN confidence REAL;
        ALTER TABLE doc_chunks ADD COLUMN source_engine TEXT NOT NULL DEFAULT '';
        ALTER TABLE doc_chunks ADD COLUMN block_order INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE doc_chunks ADD COLUMN bbox TEXT;

        CREATE VIRTUAL TABLE IF NOT EXISTS doc_chunks_fts USING fts5(
          content, tokenize='unicode61', content='doc_chunks', content_rowid='rowid'
        );

        CREATE TRIGGER IF NOT EXISTS doc_chunks_ai AFTER INSERT ON doc_chunks BEGIN
          INSERT INTO doc_chunks_fts(rowid, content) VALUES (new.rowid, new.content);
        END;

        CREATE TRIGGER IF NOT EXISTS doc_chunks_ad AFTER DELETE ON doc_chunks BEGIN
          INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, content)
            VALUES ('delete', old.rowid, old.content);
        END;

        CREATE TRIGGER IF NOT EXISTS doc_chunks_au AFTER UPDATE ON doc_chunks BEGIN
          INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, content)
            VALUES ('delete', old.rowid, old.content);
          INSERT INTO doc_chunks_fts(rowid, content)
            VALUES (new.rowid, new.content);
        END;

        INSERT INTO doc_chunks_fts(rowid, content)
          SELECT rowid, content FROM doc_chunks
          WHERE rowid NOT IN (SELECT rowid FROM doc_chunks_fts);

        CREATE TABLE IF NOT EXISTS doc_assets (
          id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          page_num INTEGER NOT NULL,
          asset_type TEXT NOT NULL CHECK(asset_type IN ('page_image','embedded_image','figure_crop','table_crop')),
          file_path TEXT NOT NULL, width INTEGER NOT NULL DEFAULT 0, height INTEGER NOT NULL DEFAULT 0,
          bbox TEXT NOT NULL DEFAULT '{}', content_hash TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );

        CREATE INDEX IF NOT EXISTS idx_doc_assets_doc_page ON doc_assets(doc_id, page_num);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_assets_hash ON doc_assets(doc_id, content_hash);
    """)

    conn.commit()
    yield conn
    conn.close()


# ── FastAPI TestClient ──────────────────────────────────────────────────────

@pytest.fixture
def client():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from modules.pdf.router import router as pdf_router
    from modules.ai.router import router as ai_router

    app = FastAPI()
    app.include_router(pdf_router)
    app.include_router(ai_router)
    return TestClient(app)


# ── Mock vision provider ────────────────────────────────────────────────────

class MockVisionProvider:
    """A mock that returns canned summaries without calling any remote API."""

    model = "mock-vision"

    async def describe_image(self, image_path: str, prompt: str, *, temperature: float = 0.2) -> str:
        return (
            'Diagram shows key components of system architecture design. '
            'Top layer: Presentation, Middle: Business Logic, Bottom: Data Access. '
            'Layers communicate through interfaces following layered architecture principles.'
        )
