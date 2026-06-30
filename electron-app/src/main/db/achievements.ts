import Database from 'better-sqlite3-multiple-ciphers'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

export interface AchievementDef {
  id: string
  title: string
  desc: string
  icon: string
  condition: { type: string; value: number }
}

export interface Achievement extends AchievementDef {
  unlocked_at: string | null
}

function getDefsPath(): string {
  // In packaged app, resources/ is at process.resourcesPath
  if (app.isPackaged) {
    return join(process.resourcesPath, 'achievements.json')
  }
  // Dev: relative to project root
  return join(__dirname, '../../../../resources/achievements.json')
}

export function getAchievementDefs(): AchievementDef[] {
  try {
    const p = getDefsPath()
    if (!existsSync(p)) return []
    return JSON.parse(readFileSync(p, 'utf-8')) as AchievementDef[]
  } catch {
    return []
  }
}

export function listAchievements(db: Database.Database): Achievement[] {
  const defs = getAchievementDefs()
  const rows = db.prepare('SELECT id, unlocked_at FROM achievements').all() as { id: string; unlocked_at: string }[]
  const unlockedMap = new Map(rows.map((r) => [r.id, r.unlocked_at]))
  return defs.map((def) => ({ ...def, unlocked_at: unlockedMap.get(def.id) ?? null }))
}

export function unlockAchievement(db: Database.Database, id: string): boolean {
  const info = db.prepare('INSERT OR IGNORE INTO achievements (id) VALUES (?)').run(id)
  return info.changes > 0
}

// Returns newly unlocked achievements after checking all conditions.
// Call this after any event that might satisfy a condition.
export function checkAndUnlockAchievements(db: Database.Database): Achievement[] {
  const defs = getAchievementDefs()
  const alreadyUnlocked = new Set(
    (db.prepare('SELECT id FROM achievements').all() as { id: string }[]).map((r) => r.id)
  )
  const newlyUnlocked: Achievement[] = []

  for (const def of defs) {
    if (alreadyUnlocked.has(def.id)) continue

    let met = false
    const { type, value } = def.condition

    switch (type) {
      case 'total_answered': {
        const row = db.prepare('SELECT COUNT(*) as cnt FROM answer_records').get() as { cnt: number }
        met = row.cnt >= value
        break
      }

      case 'streak_days': {
        // Get all dates with at least one completed plan_task
        const rows = db.prepare(`
          SELECT DISTINCT date(completed_at) as d
          FROM plan_tasks
          WHERE status = 'completed' AND completed_at IS NOT NULL
          ORDER BY d DESC
        `).all() as { d: string }[]

        let streak = 0
        const today = new Date().toISOString().slice(0, 10)
        let expected = today

        for (const { d } of rows) {
          if (d === expected) {
            streak++
            const prev = new Date(expected)
            prev.setDate(prev.getDate() - 1)
            expected = prev.toISOString().slice(0, 10)
          } else {
            break
          }
        }
        met = streak >= value
        break
      }

      case 'total_pomodoros': {
        const row = db.prepare(`
          SELECT COUNT(*) as cnt FROM study_sessions
          WHERE type = 'pomodoro' AND duration_ms IS NOT NULL
        `).get() as { cnt: number }
        met = row.cnt >= value
        break
      }

      case 'practice_accuracy': {
        const row = db.prepare(`
          SELECT ps.id,
                 COUNT(ar.id) as total,
                 SUM(CASE WHEN ar.is_correct = 1 THEN 1 ELSE 0 END) as correct
          FROM practice_sessions ps
          JOIN answer_records ar ON ar.session_id = ps.id
          GROUP BY ps.id
          HAVING total >= 10 AND (correct * 100.0 / total) >= ?
          LIMIT 1
        `).get(value) as { id: string } | undefined
        met = row != null
        break
      }

      case 'perfect_practice': {
        const row = db.prepare(`
          SELECT ps.id,
                 COUNT(ar.id) as total,
                 SUM(CASE WHEN ar.is_correct = 1 THEN 1 ELSE 0 END) as correct
          FROM practice_sessions ps
          JOIN answer_records ar ON ar.session_id = ps.id
          GROUP BY ps.id
          HAVING total >= ? AND total = correct
          LIMIT 1
        `).get(value) as { id: string } | undefined
        met = row != null
        break
      }

      case 'total_docs': {
        const row = db.prepare('SELECT COUNT(*) as cnt FROM documents').get() as { cnt: number }
        met = row.cnt >= value
        break
      }
    }

    if (met) {
      unlockAchievement(db, def.id)
      newlyUnlocked.push({ ...def, unlocked_at: new Date().toISOString() })
    }
  }

  return newlyUnlocked
}
