-- Crawler rules
CREATE TABLE IF NOT EXISTS crawler_rules (
  id              TEXT PRIMARY KEY,
  site_name       TEXT NOT NULL,
  url_template    TEXT NOT NULL,
  item_selector   TEXT NOT NULL,
  question_field  TEXT NOT NULL,
  options_field   TEXT,
  answer_field    TEXT,
  expl_field      TEXT,
  max_pages       INTEGER NOT NULL DEFAULT 5,
  delay_ms        INTEGER NOT NULL DEFAULT 1500,
  is_enabled      INTEGER NOT NULL DEFAULT 1,
  total_crawled   INTEGER NOT NULL DEFAULT 0,
  last_run_at     TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS crawler_runs (
  id          TEXT PRIMARY KEY,
  rule_id     TEXT NOT NULL REFERENCES crawler_rules(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'running',
  total_found INTEGER NOT NULL DEFAULT 0,
  total_saved INTEGER NOT NULL DEFAULT 0,
  started_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at    TEXT,
  error_msg   TEXT
);

-- Essays
CREATE TABLE IF NOT EXISTS essays (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '未命名论文',
  question   TEXT NOT NULL DEFAULT '',
  version    INTEGER NOT NULL DEFAULT 1,
  word_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS essay_sections (
  id          TEXT PRIMARY KEY,
  essay_id    TEXT NOT NULL REFERENCES essays(id) ON DELETE CASCADE,
  section_key TEXT NOT NULL,
  content     TEXT NOT NULL DEFAULT '',
  word_count  INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(essay_id, section_key)
);

CREATE TABLE IF NOT EXISTS essay_versions (
  id       TEXT PRIMARY KEY,
  essay_id TEXT NOT NULL REFERENCES essays(id) ON DELETE CASCADE,
  version  INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS essay_materials (
  id             TEXT PRIMARY KEY,
  project_name   TEXT NOT NULL,
  background     TEXT NOT NULL DEFAULT '',
  challenges     TEXT NOT NULL DEFAULT '',
  solution       TEXT NOT NULL DEFAULT '',
  outcomes       TEXT NOT NULL DEFAULT '',
  knowledge_tags TEXT NOT NULL DEFAULT '[]',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_crawler_runs_rule ON crawler_runs(rule_id);
CREATE INDEX IF NOT EXISTS idx_essay_sections_essay ON essay_sections(essay_id);
CREATE INDEX IF NOT EXISTS idx_essay_versions_essay ON essay_versions(essay_id, version);
