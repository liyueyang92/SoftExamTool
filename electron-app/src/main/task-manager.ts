import Database from 'better-sqlite3-multiple-ciphers'
import crypto from 'crypto'

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface Task {
  id: string
  type: string
  status: TaskStatus
  payload: unknown
  result: unknown
  created_at: string
  updated_at: string
}

interface TaskRow {
  id: string
  type: string
  status: string
  payload: string
  result: string | null
  created_at: string
  updated_at: string
}

export class TaskManager {
  private db: InstanceType<typeof Database>

  constructor(db: InstanceType<typeof Database>) {
    this.db = db
  }

  recoverOrphanedTasks(): void {
    const now = new Date().toISOString()
    const info = this.db
      .prepare(
        `UPDATE tasks SET status = 'failed', result = ?, updated_at = ?
         WHERE status IN ('running', 'pending')`
      )
      .run(JSON.stringify({ error: 'Process restarted unexpectedly' }), now)
    if (info.changes > 0) {
      console.log(`[TaskManager] Marked ${info.changes} orphaned task(s) as failed`)
    }
  }

  createTask(type: string, payload: unknown): string {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO tasks (id, type, status, payload, created_at, updated_at)
         VALUES (?, ?, 'pending', ?, ?, ?)`
      )
      .run(id, type, JSON.stringify(payload), now, now)
    return id
  }

  updateTask(id: string, status: TaskStatus, result?: unknown): void {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `UPDATE tasks SET status = ?, result = ?, updated_at = ? WHERE id = ?`
      )
      .run(status, result !== undefined ? JSON.stringify(result) : null, now, id)
  }

  getTask(id: string): Task | undefined {
    const row = this.db
      .prepare('SELECT * FROM tasks WHERE id = ?')
      .get(id) as TaskRow | undefined
    return row ? this.deserialize(row) : undefined
  }

  cancelTask(id: string): void {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `UPDATE tasks SET status = 'cancelled', updated_at = ?
         WHERE id = ? AND status IN ('pending', 'running')`
      )
      .run(now, id)
  }

  private deserialize(row: TaskRow): Task {
    return {
      id: row.id,
      type: row.type,
      status: row.status as TaskStatus,
      payload: JSON.parse(row.payload),
      result: row.result ? JSON.parse(row.result) : null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  }
}
