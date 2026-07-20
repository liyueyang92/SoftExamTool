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
  {
    version: 10,
    sql: `
ALTER TABLE questions ADD COLUMN question_set_id TEXT;
ALTER TABLE questions ADD COLUMN question_set_order INTEGER NOT NULL DEFAULT 0;

CREATE TEMP TABLE question_set_backfill (
  content TEXT PRIMARY KEY,
  set_id TEXT NOT NULL
);

INSERT INTO question_set_backfill (content, set_id)
SELECT content, lower(hex(randomblob(16)))
FROM questions
WHERE options IS NOT NULL AND trim(options) <> ''
GROUP BY content
HAVING COUNT(*) > 1 AND COUNT(DISTINCT options) > 1;

CREATE TEMP TABLE question_set_order_backfill AS
SELECT
  q.id,
  b.set_id,
  ROW_NUMBER() OVER (PARTITION BY q.content ORDER BY q.created_at, q.id) AS order_no
FROM questions q
JOIN question_set_backfill b ON b.content = q.content;

UPDATE questions
SET
  question_set_id = (
    SELECT set_id FROM question_set_order_backfill item WHERE item.id = questions.id
  ),
  question_set_order = (
    SELECT order_no FROM question_set_order_backfill item WHERE item.id = questions.id
  )
WHERE id IN (SELECT id FROM question_set_order_backfill);

DROP TABLE question_set_order_backfill;
DROP TABLE question_set_backfill;

CREATE INDEX IF NOT EXISTS idx_questions_set
  ON questions(question_set_id, question_set_order);
`,
  },
  {
    version: 11,
    sql: `
CREATE TABLE IF NOT EXISTS question_images (
  id            TEXT PRIMARY KEY,
  question_id   TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  field_name    TEXT NOT NULL CHECK(field_name IN ('content','options','explanation')),
  file_name     TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  file_size     INTEGER NOT NULL DEFAULT 0,
  width         INTEGER,
  height        INTEGER,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_question_images_question
  ON question_images(question_id, field_name);
`,
  },
  {
    version: 12,
    sql: `
ALTER TABLE questions ADD COLUMN exam_year INTEGER;
ALTER TABLE questions ADD COLUMN exam_period TEXT CHECK(exam_period IS NULL OR exam_period IN ('H1','H2'));

ALTER TABLE crawler_runs ADD COLUMN exam_year INTEGER;
ALTER TABLE crawler_runs ADD COLUMN exam_period TEXT;

UPDATE questions
SET
  exam_year = (SELECT g.exam_year FROM question_groups g WHERE g.id = questions.group_id),
  exam_period = (SELECT g.exam_period FROM question_groups g WHERE g.id = questions.group_id)
WHERE group_id IS NOT NULL;

UPDATE crawler_runs
SET
  exam_year = (SELECT g.exam_year FROM question_groups g WHERE g.id = crawler_runs.target_group_id),
  exam_period = (SELECT g.exam_period FROM question_groups g WHERE g.id = crawler_runs.target_group_id)
WHERE target_group_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_questions_exam ON questions(exam_year, exam_period);
`,
  },
  {
    version: 13,
    sql: `
-- Step 1: identify the keeper row per unique key
CREATE TEMP TABLE group_dedup_keep AS
SELECT
  g.id,
  g.name,
  g.group_type,
  COALESCE(g.exam_year, -1) AS ey,
  COALESCE(g.exam_period, '') AS ep
FROM question_groups g
WHERE g.id = (
  SELECT g2.id FROM question_groups g2
  WHERE g2.name = g.name
    AND g2.group_type = g.group_type
    AND COALESCE(g2.exam_year, -1) = COALESCE(g.exam_year, -1)
    AND COALESCE(g2.exam_period, '') = COALESCE(g.exam_period, '')
  ORDER BY
    (SELECT COUNT(*) FROM questions WHERE group_id = g2.id) DESC,
    g2.created_at ASC
  LIMIT 1
);

-- Step 2: reassign questions from duplicate groups to the keeper
UPDATE questions SET group_id = (
  SELECT k.id FROM group_dedup_keep k
  JOIN question_groups g ON g.id = questions.group_id
  WHERE g.name = k.name
    AND g.group_type = k.group_type
    AND COALESCE(g.exam_year, -1) = k.ey
    AND COALESCE(g.exam_period, '') = k.ep
    AND g.id != k.id
)
WHERE group_id IN (
  SELECT g.id FROM question_groups g
  WHERE NOT EXISTS (SELECT 1 FROM group_dedup_keep k WHERE k.id = g.id)
    AND EXISTS (
      SELECT 1 FROM group_dedup_keep k
      WHERE g.name = k.name
        AND g.group_type = k.group_type
        AND COALESCE(g.exam_year, -1) = k.ey
        AND COALESCE(g.exam_period, '') = k.ep
    )
);

-- Step 3: remove duplicate rows
DELETE FROM question_groups WHERE id NOT IN (SELECT id FROM group_dedup_keep);

DROP TABLE group_dedup_keep;

-- Step 4: enforce uniqueness going forward
CREATE UNIQUE INDEX IF NOT EXISTS idx_question_groups_unique
  ON question_groups(name, group_type, COALESCE(exam_year, -1), COALESCE(exam_period, ''));
`,
  },
  {
    version: 14,
    sql: `
ALTER TABLE crawler_runs ADD COLUMN total_review INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    version: 15,
    sql: `
ALTER TABLE questions ADD COLUMN content_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_questions_content_hash ON questions(content_hash);
`,
  },
  {
    version: 16,
    sql: `
ALTER TABLE crawler_review_items ADD COLUMN imported_question_id TEXT REFERENCES questions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_crawler_review_imported_q
  ON crawler_review_items(imported_question_id);
`,
  },
  {
    version: 17,
    sql: `
-- 扩展 doc_chunks 表：新增内容类型、资产关联、置信度、引擎、排序、坐标
ALTER TABLE doc_chunks ADD COLUMN chunk_type TEXT NOT NULL DEFAULT 'text'
  CHECK(chunk_type IN ('text','table','figure','page_summary'));
ALTER TABLE doc_chunks ADD COLUMN asset_id TEXT;
ALTER TABLE doc_chunks ADD COLUMN confidence REAL;
ALTER TABLE doc_chunks ADD COLUMN source_engine TEXT NOT NULL DEFAULT '';
ALTER TABLE doc_chunks ADD COLUMN block_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE doc_chunks ADD COLUMN bbox TEXT;

-- doc_chunks 全文索引（FTS5）
CREATE VIRTUAL TABLE IF NOT EXISTS doc_chunks_fts USING fts5(
  content,
  tokenize='unicode61',
  content='doc_chunks',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS doc_chunks_ai AFTER INSERT ON doc_chunks BEGIN
  INSERT INTO doc_chunks_fts(rowid, content)
  VALUES (new.rowid, new.content);
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

-- 历史数据回填 FTS
INSERT INTO doc_chunks_fts(rowid, content)
SELECT rowid, content FROM doc_chunks
WHERE rowid NOT IN (SELECT rowid FROM doc_chunks_fts);

-- 新增 doc_assets 表（图片/表格资产）
CREATE TABLE IF NOT EXISTS doc_assets (
  id             TEXT PRIMARY KEY,
  doc_id         TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_num       INTEGER NOT NULL,
  asset_type     TEXT NOT NULL CHECK(asset_type IN ('page_image','embedded_image','figure_crop','table_crop')),
  file_path      TEXT NOT NULL,
  width          INTEGER NOT NULL DEFAULT 0,
  height         INTEGER NOT NULL DEFAULT 0,
  bbox           TEXT NOT NULL DEFAULT '{}',
  content_hash   TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_doc_assets_doc_page ON doc_assets(doc_id, page_num);
CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_assets_hash ON doc_assets(doc_id, content_hash);
`,
  },
  {
    version: 18,
    sql: `
-- 考试全局配置（单例记录）
CREATE TABLE IF NOT EXISTS exam_config (
  id                TEXT PRIMARY KEY DEFAULT 'singleton',
  exam_name         TEXT NOT NULL DEFAULT '系统架构设计师',
  exam_date         TEXT,
  syllabus_version  TEXT NOT NULL DEFAULT '2024',
  target_score      INTEGER NOT NULL DEFAULT 45,
  daily_min_minutes INTEGER NOT NULL DEFAULT 60,
  daily_max_minutes INTEGER NOT NULL DEFAULT 180,
  study_start_time  TEXT NOT NULL DEFAULT '19:00',
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 知识域层级表（软考大纲三级结构）
CREATE TABLE IF NOT EXISTS knowledge_domains (
  id              TEXT PRIMARY KEY,
  parent_id       TEXT REFERENCES knowledge_domains(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  level           INTEGER NOT NULL CHECK(level IN (1,2,3)),
  sort_order      INTEGER NOT NULL DEFAULT 0,
  suggested_min   INTEGER NOT NULL DEFAULT 60,
  weight_pct      REAL NOT NULL DEFAULT 0,
  is_required     INTEGER NOT NULL DEFAULT 1,
  outline_ref     TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_kd_parent ON knowledge_domains(parent_id);
CREATE INDEX IF NOT EXISTS idx_kd_level ON knowledge_domains(level, sort_order);

-- 学习日志（每日按时段记录）
CREATE TABLE IF NOT EXISTS learning_logs (
  id                TEXT PRIMARY KEY,
  log_date          TEXT NOT NULL,
  time_slot         TEXT NOT NULL CHECK(time_slot IN ('morning','afternoon','evening')),
  task_id           TEXT REFERENCES plan_tasks(id) ON DELETE SET NULL,
  focus_minutes     INTEGER NOT NULL DEFAULT 0,
  pomodoro_cycles   INTEGER NOT NULL DEFAULT 0,
  interruption_count INTEGER NOT NULL DEFAULT 0,
  self_rating       INTEGER CHECK(self_rating BETWEEN 1 AND 5),
  notes             TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_learning_logs_date ON learning_logs(log_date);
CREATE INDEX IF NOT EXISTS idx_learning_logs_task ON learning_logs(task_id);
`,
  },
  {
    version: 19,
    sql: `
-- 扩展 plan_tasks 表：增加任务类型、优先级、关联题目/文档
ALTER TABLE plan_tasks ADD COLUMN task_type TEXT NOT NULL DEFAULT 'practice'
  CHECK(task_type IN ('reading','video','practice','review','essay','mock_exam','custom'));
ALTER TABLE plan_tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE plan_tasks ADD COLUMN estimated_min INTEGER NOT NULL DEFAULT 30;
ALTER TABLE plan_tasks ADD COLUMN actual_min INTEGER;
ALTER TABLE plan_tasks ADD COLUMN doc_id TEXT REFERENCES documents(id) ON DELETE SET NULL;
ALTER TABLE plan_tasks ADD COLUMN doc_page_range TEXT;
ALTER TABLE plan_tasks ADD COLUMN linked_question_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE plan_tasks ADD COLUMN linked_essay_id TEXT REFERENCES essays(id) ON DELETE SET NULL;
ALTER TABLE plan_tasks ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;

-- 计划模板表
CREATE TABLE IF NOT EXISTS plan_templates (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  phase           TEXT NOT NULL CHECK(phase IN ('foundation','reinforcement','sprint')),
  task_rules_json TEXT NOT NULL DEFAULT '{}',
  is_builtin      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`,
  },
  {
    version: 20,
    sql: `
-- 通知记录
CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL CHECK(type IN ('daily_plan','progress_warning','streak_milestone',
              'countdown','pomodoro_end','achievement','system')),
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  action_url  TEXT,
  is_read     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(is_read, created_at DESC);

-- 专注会话扩展（记录中断详情）
ALTER TABLE study_sessions ADD COLUMN interruption_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE study_sessions ADD COLUMN focus_rating INTEGER CHECK(focus_rating BETWEEN 1 AND 5);
`,
  },
  {
    version: 21,
    sql: `
-- plan_tasks: multi-document linking — JSON array of {doc_id, page_range, title, chunk_count}
ALTER TABLE plan_tasks ADD COLUMN linked_doc_ids TEXT NOT NULL DEFAULT '[]';
`,
  },
  {
    version: 22,
    sql: `
-- documents: mark one as official textbook (全局唯一官方教材标记)
ALTER TABLE documents ADD COLUMN is_official INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    version: 23,
    sql: `
-- Phase 0: 知识点标签清洗与质量保障

-- 标签修正记录（用于反馈闭环与回滚）
CREATE TABLE IF NOT EXISTS tag_corrections (
  id              TEXT PRIMARY KEY,
  chunk_id        TEXT REFERENCES doc_chunks(id) ON DELETE CASCADE,
  old_tags        TEXT NOT NULL,          -- JSON array
  new_tags        TEXT NOT NULL,          -- JSON array
  old_confidence  REAL,
  new_confidence  REAL,
  action          TEXT NOT NULL           -- 'noise_cleared' | 'reclassified' | 'low_confidence_cleared' | 'ai_corrected' | 'human_corrected' | 'confirm_empty' | 'confirm_original'
    CHECK(action IN ('noise_cleared','reclassified','low_confidence_cleared','ai_corrected','human_corrected','confirm_empty','confirm_original')),
  corrected_by    TEXT NOT NULL DEFAULT 'system',  -- 'system' | 'ai' | 'human'
  pattern_tag     TEXT,                   -- 常见错误模式标记
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_tag_corrections_chunk ON tag_corrections(chunk_id);
CREATE INDEX IF NOT EXISTS idx_tag_corrections_action ON tag_corrections(action);

-- 清洗操作日志（用于可回滚设计）
CREATE TABLE IF NOT EXISTS cleaning_log (
  id              TEXT PRIMARY KEY,
  doc_id          TEXT REFERENCES documents(id) ON DELETE CASCADE,
  total_chunks    INTEGER NOT NULL DEFAULT 0,
  noise_cleared   TEXT NOT NULL DEFAULT '{}',   -- JSON: {toc: N, preface: N, ...}
  ai_reclassified INTEGER NOT NULL DEFAULT 0,
  downgraded      INTEGER NOT NULL DEFAULT 0,
  populated       INTEGER NOT NULL DEFAULT 0,
  unchanged       INTEGER NOT NULL DEFAULT 0,
  confidence_stats TEXT NOT NULL DEFAULT '{}',   -- JSON: {mean, median, p10, p90}
  snapshot_ids    TEXT NOT NULL DEFAULT '[]',    -- JSON: 备份的 tag_corrections IDs
  cleaned_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_cleaning_log_doc ON cleaning_log(doc_id);

-- 题目标注历史（Phase 2/3 使用，提前建表）
CREATE TABLE IF NOT EXISTS question_tag_history (
  id            TEXT PRIMARY KEY,
  question_id   TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  old_tags      TEXT NOT NULL,          -- JSON array
  new_tags      TEXT NOT NULL,          -- JSON array
  source        TEXT NOT NULL           -- 'fts_document' | 'ai_classifier' | 'keyword_fallback' | 'manual' | 'question_set_sync'
    CHECK(source IN ('fts_document','ai_classifier','keyword_fallback','manual','question_set_sync')),
  confidence    REAL,
  details       TEXT,                   -- JSON: source chunk info or AI reasoning
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_qth_question ON question_tag_history(question_id);
CREATE INDEX IF NOT EXISTS idx_qth_source ON question_tag_history(source);
`,
  },
  {
    version: 24,
    sql: `
-- Phase 0 fix: 修复 tag_corrections CHECK 约束，增加 'low_confidence_cleared'
-- SQLite 不支持 ALTER TABLE 修改 CHECK，需要用重建方式
CREATE TABLE IF NOT EXISTS tag_corrections_v2 (
  id              TEXT PRIMARY KEY,
  chunk_id        TEXT REFERENCES doc_chunks(id) ON DELETE CASCADE,
  old_tags        TEXT NOT NULL,
  new_tags        TEXT NOT NULL,
  old_confidence  REAL,
  new_confidence  REAL,
  action          TEXT NOT NULL
    CHECK(action IN ('noise_cleared','reclassified','low_confidence_cleared','ai_corrected','human_corrected','confirm_empty','confirm_original')),
  corrected_by    TEXT NOT NULL DEFAULT 'system',
  pattern_tag     TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 检查旧表是否存在（v23 已创建但 CHECK 不对）
INSERT OR IGNORE INTO tag_corrections_v2
  SELECT * FROM tag_corrections
  WHERE action IN ('noise_cleared','reclassified','low_confidence_cleared','ai_corrected','human_corrected','confirm_empty','confirm_original');

-- 如果有不符合新 CHECK 的行，修正其 action 为 'reclassified'
INSERT OR IGNORE INTO tag_corrections_v2
  SELECT id, chunk_id, old_tags, new_tags, old_confidence, new_confidence,
    'reclassified' AS action, corrected_by, pattern_tag, created_at
  FROM tag_corrections
  WHERE action NOT IN ('noise_cleared','reclassified','low_confidence_cleared','ai_corrected','human_corrected','confirm_empty','confirm_original');

DROP TABLE IF EXISTS tag_corrections;
ALTER TABLE tag_corrections_v2 RENAME TO tag_corrections;

CREATE INDEX IF NOT EXISTS idx_tag_corrections_chunk ON tag_corrections(chunk_id);
CREATE INDEX IF NOT EXISTS idx_tag_corrections_action ON tag_corrections(action);
`,
  },
  {
    version: 25,
    sql: `
-- 修复 question_tag_history CHECK 约束，增加 'question_set_sync'
CREATE TABLE IF NOT EXISTS question_tag_history_v2 (
  id            TEXT PRIMARY KEY,
  question_id   TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  old_tags      TEXT NOT NULL,
  new_tags      TEXT NOT NULL,
  source        TEXT NOT NULL
    CHECK(source IN ('fts_document','ai_classifier','keyword_fallback','manual','question_set_sync')),
  confidence    REAL,
  details       TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT OR IGNORE INTO question_tag_history_v2
  SELECT * FROM question_tag_history;

DROP TABLE IF EXISTS question_tag_history;
ALTER TABLE question_tag_history_v2 RENAME TO question_tag_history;

CREATE INDEX IF NOT EXISTS idx_qth_question ON question_tag_history(question_id);
CREATE INDEX IF NOT EXISTS idx_qth_source ON question_tag_history(source);
`,
  },
]
