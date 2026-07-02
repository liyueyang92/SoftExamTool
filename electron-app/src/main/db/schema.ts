/**
 * All database migrations defined inline.
 * version must match the old SQL filename prefix (0001 → 1, etc.) for
 * backward compatibility with existing databases that already have a
 * user_version set by the file-based migrator.
 */
export interface Migration {
  version: number
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS questions (
  id             TEXT PRIMARY KEY,
  type           TEXT NOT NULL CHECK(type IN ('single','multiple','case','essay')),
  content        TEXT NOT NULL,
  options        TEXT,
  answer         TEXT,
  explanation    TEXT,
  knowledge_tags TEXT NOT NULL DEFAULT '[]',
  difficulty     INTEGER NOT NULL DEFAULT 3 CHECK(difficulty BETWEEN 1 AND 5),
  source_type    TEXT NOT NULL DEFAULT 'manual'
                   CHECK(source_type IN ('manual','ai_generated','crawled','imported')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS answer_records (
  id                    TEXT PRIMARY KEY,
  question_id           TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  session_id            TEXT NOT NULL,
  chosen                TEXT,
  is_correct            INTEGER,
  time_spent_ms         INTEGER,
  ai_feedback           TEXT,
  manual_override_score REAL,
  answered_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS study_plans (
  id         TEXT PRIMARY KEY,
  mode       TEXT NOT NULL DEFAULT 'normal' CHECK(mode IN ('normal','sprint')),
  exam_date  TEXT,
  config     TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS plan_tasks (
  id              TEXT PRIMARY KEY,
  plan_id         TEXT NOT NULL REFERENCES study_plans(id) ON DELETE CASCADE,
  date            TEXT NOT NULL,
  knowledge_tag   TEXT NOT NULL,
  suggested_count INTEGER NOT NULL DEFAULT 10,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending','in_progress','completed')),
  completed_at    TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending'
               CHECK(status IN ('pending','running','completed','failed','cancelled')),
  payload    TEXT NOT NULL DEFAULT '{}',
  result     TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
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

CREATE VIRTUAL TABLE IF NOT EXISTS questions_fts USING fts5(
  content,
  explanation,
  tokenize='unicode61',
  content='questions',
  content_rowid='rowid'
);

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

CREATE INDEX IF NOT EXISTS idx_questions_type       ON questions(type);
CREATE INDEX IF NOT EXISTS idx_questions_source     ON questions(source_type);
CREATE INDEX IF NOT EXISTS idx_answer_records_session  ON answer_records(session_id);
CREATE INDEX IF NOT EXISTS idx_answer_records_question ON answer_records(question_id);
CREATE INDEX IF NOT EXISTS idx_plan_tasks_plan      ON plan_tasks(plan_id, date);
CREATE INDEX IF NOT EXISTS idx_tasks_status         ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_doc_chunks_doc       ON doc_chunks(doc_id);
`,
  },
  {
    version: 2,
    sql: `
ALTER TABLE questions ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS practice_sessions (
  id            TEXT PRIMARY KEY,
  mode          TEXT NOT NULL DEFAULT 'random'
                  CHECK(mode IN ('random','sequential','wrong','favorites')),
  filter_tags   TEXT NOT NULL DEFAULT '[]',
  filter_types  TEXT NOT NULL DEFAULT '[]',
  total_count   INTEGER NOT NULL DEFAULT 0,
  correct_count INTEGER NOT NULL DEFAULT 0,
  started_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_questions_favorite     ON questions(is_favorite);
CREATE INDEX IF NOT EXISTS idx_practice_sessions_started ON practice_sessions(started_at DESC);
`,
  },
  {
    version: 3,
    sql: `
CREATE TABLE IF NOT EXISTS crawler_rules (
  id             TEXT PRIMARY KEY,
  site_name      TEXT NOT NULL,
  url_template   TEXT NOT NULL,
  item_selector  TEXT NOT NULL,
  question_field TEXT NOT NULL,
  options_field  TEXT,
  answer_field   TEXT,
  expl_field     TEXT,
  max_pages      INTEGER NOT NULL DEFAULT 5,
  delay_ms       INTEGER NOT NULL DEFAULT 1500,
  is_enabled     INTEGER NOT NULL DEFAULT 1,
  total_crawled  INTEGER NOT NULL DEFAULT 0,
  last_run_at    TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
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

CREATE INDEX IF NOT EXISTS idx_crawler_runs_rule       ON crawler_runs(rule_id);
CREATE INDEX IF NOT EXISTS idx_essay_sections_essay    ON essay_sections(essay_id);
CREATE INDEX IF NOT EXISTS idx_essay_versions_essay    ON essay_versions(essay_id, version);
`,
  },
  {
    version: 4,
    sql: `
CREATE TABLE IF NOT EXISTS study_sessions (
  id           TEXT PRIMARY KEY,
  plan_task_id TEXT REFERENCES plan_tasks(id) ON DELETE SET NULL,
  type         TEXT NOT NULL DEFAULT 'manual' CHECK(type IN ('manual','pomodoro')),
  started_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at     TEXT,
  duration_ms  INTEGER
);

ALTER TABLE plan_tasks ADD COLUMN actual_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_sessions_started ON study_sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_plan_tasks_date  ON plan_tasks(date);
`,
  },
  {
    version: 5,
    sql: `
CREATE TABLE IF NOT EXISTS achievements (
  id          TEXT PRIMARY KEY,
  unlocked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS backup_records (
  id         TEXT PRIMARY KEY,
  file_path  TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_backup_created ON backup_records(created_at);
`,
  },
  {
    version: 6,
    sql: `
CREATE TABLE IF NOT EXISTS ai_chat_messages (
  id         TEXT PRIMARY KEY,
  role       TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content    TEXT NOT NULL,
  sources    TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_chat_created ON ai_chat_messages(created_at);
`,
  },
  {
    version: 7,
    sql: `
CREATE TABLE IF NOT EXISTS ai_chat_sessions (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT 'New Chat',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

ALTER TABLE ai_chat_messages ADD COLUMN session_id TEXT;

INSERT OR IGNORE INTO ai_chat_sessions (id, title)
SELECT 'legacy-default-session', 'Imported History'
WHERE EXISTS (
  SELECT 1
  FROM ai_chat_messages
  WHERE session_id IS NULL OR session_id = ''
);

UPDATE ai_chat_messages
SET session_id = 'legacy-default-session'
WHERE session_id IS NULL OR session_id = '';

CREATE INDEX IF NOT EXISTS idx_ai_chat_session_id ON ai_chat_messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_chat_sessions_updated ON ai_chat_sessions(updated_at DESC);
`,
  },
  {
    version: 8,
    sql: `
CREATE TABLE IF NOT EXISTS question_groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  group_type  TEXT NOT NULL DEFAULT 'custom'
               CHECK(group_type IN ('custom','past_exam','ai_generated','crawled','manual_import')),
  exam_year   INTEGER,
  exam_period TEXT
               CHECK(exam_period IS NULL OR exam_period IN ('H1','H2')),
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

ALTER TABLE questions ADD COLUMN group_id TEXT REFERENCES question_groups(id) ON DELETE SET NULL;
ALTER TABLE questions ADD COLUMN source_url TEXT;

CREATE INDEX IF NOT EXISTS idx_questions_group           ON questions(group_id);
CREATE INDEX IF NOT EXISTS idx_question_groups_type      ON question_groups(group_type);
CREATE INDEX IF NOT EXISTS idx_question_groups_exam_meta ON question_groups(exam_year, exam_period);
`,
  },
  {
    version: 9,
    sql: `
ALTER TABLE crawler_rules ADD COLUMN adapter TEXT NOT NULL DEFAULT 'http_rule'
  CHECK(adapter IN ('http_rule','browser_rule','api_json','feed_import','manual_clip'));
ALTER TABLE crawler_rules ADD COLUMN auth_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE crawler_rules ADD COLUMN auth_mode TEXT NOT NULL DEFAULT 'none'
  CHECK(auth_mode IN ('none','manual_session'));
ALTER TABLE crawler_rules ADD COLUMN login_url TEXT;
ALTER TABLE crawler_rules ADD COLUMN validate_url TEXT;
ALTER TABLE crawler_rules ADD COLUMN rule_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE crawler_rules ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE crawler_rules ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
UPDATE crawler_rules
SET updated_at = COALESCE(created_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
WHERE updated_at = '';

ALTER TABLE crawler_runs ADD COLUMN target_group_id TEXT REFERENCES question_groups(id) ON DELETE SET NULL;
ALTER TABLE crawler_runs ADD COLUMN error_code TEXT;
ALTER TABLE crawler_runs ADD COLUMN error_stage TEXT;

CREATE TABLE IF NOT EXISTS crawler_site_sessions (
  id                  TEXT PRIMARY KEY,
  site_id             TEXT NOT NULL,
  site_name           TEXT NOT NULL,
  account_alias       TEXT NOT NULL DEFAULT 'default',
  auth_mode           TEXT NOT NULL DEFAULT 'manual_session',
  encrypted_state     BLOB NOT NULL,
  storage_meta        TEXT NOT NULL DEFAULT '{}',
  last_validated_at   TEXT,
  expires_at          TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(site_id, account_alias)
);

CREATE TABLE IF NOT EXISTS crawler_review_items (
  id                    TEXT PRIMARY KEY,
  rule_id               TEXT NOT NULL REFERENCES crawler_rules(id) ON DELETE CASCADE,
  run_id                TEXT NOT NULL REFERENCES crawler_runs(id) ON DELETE CASCADE,
  content_hash          TEXT NOT NULL,
  normalized_payload    TEXT NOT NULL,
  target_group_id       TEXT REFERENCES question_groups(id) ON DELETE SET NULL,
  target_group_snapshot TEXT,
  review_status         TEXT NOT NULL DEFAULT 'pending'
                          CHECK(review_status IN ('pending','approved','rejected','imported')),
  review_notes          TEXT NOT NULL DEFAULT '',
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(rule_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_crawler_sessions_site
  ON crawler_site_sessions(site_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_crawler_review_status
  ON crawler_review_items(review_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crawler_review_run
  ON crawler_review_items(run_id);
CREATE INDEX IF NOT EXISTS idx_crawler_review_rule_hash
  ON crawler_review_items(rule_id, content_hash);
`,
  },
]
