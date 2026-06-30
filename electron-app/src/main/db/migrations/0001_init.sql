-- Phase 1 initial schema

CREATE TABLE IF NOT EXISTS questions (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL CHECK(type IN ('single','multiple','case','essay')),
  content       TEXT NOT NULL,
  options       TEXT,         -- JSON array, NULL for essay
  answer        TEXT,         -- NULL for essay (manual grading)
  explanation   TEXT,
  knowledge_tags TEXT NOT NULL DEFAULT '[]', -- JSON array
  difficulty    INTEGER NOT NULL DEFAULT 3 CHECK(difficulty BETWEEN 1 AND 5),
  source_type   TEXT NOT NULL DEFAULT 'manual' CHECK(source_type IN ('manual','ai_generated','crawled','imported')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS answer_records (
  id                    TEXT PRIMARY KEY,
  question_id           TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  session_id            TEXT NOT NULL,
  chosen                TEXT,          -- JSON for multiple, plain text for single/essay
  is_correct            INTEGER,       -- NULL = not yet graded (essay)
  time_spent_ms         INTEGER,
  ai_feedback           TEXT,          -- JSON {total_score, dimension_scores, feedback, suggestions}
  manual_override_score REAL,
  answered_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS study_plans (
  id          TEXT PRIMARY KEY,
  mode        TEXT NOT NULL DEFAULT 'normal' CHECK(mode IN ('normal','sprint')),
  exam_date   TEXT,
  config      TEXT NOT NULL DEFAULT '{}', -- JSON
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS plan_tasks (
  id              TEXT PRIMARY KEY,
  plan_id         TEXT NOT NULL REFERENCES study_plans(id) ON DELETE CASCADE,
  date            TEXT NOT NULL,
  knowledge_tag   TEXT NOT NULL,
  suggested_count INTEGER NOT NULL DEFAULT 10,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','completed')),
  completed_at    TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK(status IN ('pending','running','completed','failed','cancelled')),
  payload     TEXT NOT NULL DEFAULT '{}',  -- JSON
  result      TEXT,                        -- JSON, set on completion/failure
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS documents (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  file_path   TEXT NOT NULL,
  page_count  INTEGER NOT NULL DEFAULT 0,
  md5         TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS doc_chunks (
  id             TEXT PRIMARY KEY,
  doc_id         TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_num       INTEGER NOT NULL,
  content        TEXT NOT NULL,
  knowledge_tags TEXT NOT NULL DEFAULT '[]',
  vector_id      TEXT
);

-- FTS5 for full-text search on questions
CREATE VIRTUAL TABLE IF NOT EXISTS questions_fts USING fts5(
  content,
  explanation,
  tokenize='unicode61',
  content='questions',
  content_rowid='rowid'
);

-- Triggers to keep FTS5 in sync
CREATE TRIGGER IF NOT EXISTS questions_ai AFTER INSERT ON questions BEGIN
  INSERT INTO questions_fts(rowid, content, explanation)
  VALUES (new.rowid, new.content, COALESCE(new.explanation, ''));
END;

CREATE TRIGGER IF NOT EXISTS questions_ad AFTER DELETE ON questions BEGIN
  INSERT INTO questions_fts(questions_fts, rowid, content, explanation)
  VALUES ('delete', old.rowid, old.content, COALESCE(old.explanation, ''));
END;

CREATE TRIGGER IF NOT EXISTS questions_au AFTER UPDATE ON questions BEGIN
  INSERT INTO questions_fts(questions_fts, rowid, content, explanation)
  VALUES ('delete', old.rowid, old.content, COALESCE(old.explanation, ''));
  INSERT INTO questions_fts(rowid, content, explanation)
  VALUES (new.rowid, new.content, COALESCE(new.explanation, ''));
END;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_questions_type ON questions(type);
CREATE INDEX IF NOT EXISTS idx_questions_source ON questions(source_type);
CREATE INDEX IF NOT EXISTS idx_answer_records_session ON answer_records(session_id);
CREATE INDEX IF NOT EXISTS idx_answer_records_question ON answer_records(question_id);
CREATE INDEX IF NOT EXISTS idx_plan_tasks_plan ON plan_tasks(plan_id, date);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_doc_chunks_doc ON doc_chunks(doc_id);
