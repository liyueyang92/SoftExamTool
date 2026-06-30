-- Phase 4: Study Plan & Progress additions

-- Study sessions for time tracking (also used by Phase 6 pomodoro)
CREATE TABLE IF NOT EXISTS study_sessions (
  id           TEXT PRIMARY KEY,
  plan_task_id TEXT REFERENCES plan_tasks(id) ON DELETE SET NULL,
  type         TEXT NOT NULL DEFAULT 'manual' CHECK(type IN ('manual', 'pomodoro')),
  started_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at     TEXT,
  duration_ms  INTEGER
);

-- Track actual completed questions per plan task
ALTER TABLE plan_tasks ADD COLUMN actual_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_sessions_started ON study_sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_plan_tasks_date ON plan_tasks(date);
