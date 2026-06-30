-- Phase 6: Achievements & Backup

-- Track unlocked achievements (defs live in achievements.json)
CREATE TABLE IF NOT EXISTS achievements (
  id          TEXT PRIMARY KEY,
  unlocked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Manual/auto backup records
CREATE TABLE IF NOT EXISTS backup_records (
  id          TEXT PRIMARY KEY,
  file_path   TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_backup_created ON backup_records(created_at);
