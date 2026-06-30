-- Phase 2 additions

ALTER TABLE questions ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS practice_sessions (
  id             TEXT PRIMARY KEY,
  mode           TEXT NOT NULL DEFAULT 'random'
                   CHECK(mode IN ('random','sequential','wrong','favorites')),
  filter_tags    TEXT NOT NULL DEFAULT '[]',  -- JSON array of knowledge_tags
  filter_types   TEXT NOT NULL DEFAULT '[]',  -- JSON array of question types
  total_count    INTEGER NOT NULL DEFAULT 0,
  correct_count  INTEGER NOT NULL DEFAULT 0,
  started_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_questions_favorite ON questions(is_favorite);
CREATE INDEX IF NOT EXISTS idx_practice_sessions_started ON practice_sessions(started_at DESC);
