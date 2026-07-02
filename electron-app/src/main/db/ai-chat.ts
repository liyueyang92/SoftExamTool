import type { Database } from 'better-sqlite3-multiple-ciphers'
import { randomUUID } from 'crypto'

export interface AiChatSource {
  page_num: number | null
  doc_title: string
}

export interface AiChatSession {
  id: string
  title: string
  created_at: string
  updated_at: string
  message_count: number
}

export interface AiChatMessage {
  id: string
  session_id: string
  role: 'user' | 'assistant'
  content: string
  sources: AiChatSource[]
  created_at: string
}

type AiChatSessionRow = {
  id: string
  title: string
  created_at: string
  updated_at: string
  message_count: number
}

type AiChatMessageRow = {
  id: string
  session_id: string
  role: 'user' | 'assistant'
  content: string
  sources: string
  created_at: string
}

function parseSources(raw: string): AiChatSource[] {
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        page_num: typeof item.page_num === 'number' ? item.page_num : null,
        doc_title: typeof item.doc_title === 'string' ? item.doc_title : 'Document',
      }))
  } catch {
    return []
  }
}

function mapMessageRow(row: AiChatMessageRow): AiChatMessage {
  return {
    ...row,
    sources: parseSources(row.sources),
  }
}

function mapSessionRow(row: AiChatSessionRow): AiChatSession {
  return {
    ...row,
    message_count: Number(row.message_count) || 0,
  }
}

function normalizeSessionTitle(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, ' ')
  return trimmed.slice(0, 40) || 'New Chat'
}

export function listAiChatSessions(db: Database, limit = 50): AiChatSession[] {
  const rows = db.prepare(`
    SELECT
      s.id,
      s.title,
      s.created_at,
      s.updated_at,
      COUNT(m.id) AS message_count
    FROM ai_chat_sessions s
    LEFT JOIN ai_chat_messages m ON m.session_id = s.id
    GROUP BY s.id
    ORDER BY s.updated_at DESC, s.created_at DESC
    LIMIT ?
  `).all(limit) as AiChatSessionRow[]
  return rows.map(mapSessionRow)
}

export function createAiChatSession(db: Database, title = 'New Chat'): AiChatSession {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO ai_chat_sessions (id, title)
    VALUES (?, ?)
  `).run(id, normalizeSessionTitle(title))
  return getAiChatSession(db, id)!
}

export function getAiChatSession(db: Database, id: string): AiChatSession | null {
  const row = db.prepare(`
    SELECT
      s.id,
      s.title,
      s.created_at,
      s.updated_at,
      COUNT(m.id) AS message_count
    FROM ai_chat_sessions s
    LEFT JOIN ai_chat_messages m ON m.session_id = s.id
    WHERE s.id = ?
    GROUP BY s.id
  `).get(id) as AiChatSessionRow | undefined
  return row ? mapSessionRow(row) : null
}

export function getLatestAiChatSession(db: Database): AiChatSession | null {
  const sessions = listAiChatSessions(db, 1)
  return sessions[0] ?? null
}

export function listAiChatMessages(db: Database, sessionId: string, limit = 100): AiChatMessage[] {
  const rows = db.prepare(`
    SELECT *
    FROM (
      SELECT * FROM ai_chat_messages
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    )
    ORDER BY created_at ASC
  `).all(sessionId, limit) as AiChatMessageRow[]
  return rows.map(mapMessageRow)
}

export function insertAiChatMessage(
  db: Database,
  message: {
    session_id: string
    role: 'user' | 'assistant'
    content: string
    sources?: AiChatSource[]
  }
): AiChatMessage {
  const id = randomUUID()
  const now = new Date().toISOString()

  db.prepare(`
    INSERT INTO ai_chat_messages (id, session_id, role, content, sources)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, message.session_id, message.role, message.content, JSON.stringify(message.sources ?? []))

  db.prepare('UPDATE ai_chat_sessions SET updated_at=? WHERE id=?').run(now, message.session_id)

  if (message.role === 'user') {
    db.prepare(`
      UPDATE ai_chat_sessions
      SET title = ?
      WHERE id = ?
        AND (
          title = 'New Chat'
          OR title = 'Imported History'
        )
        AND (
          SELECT COUNT(*)
          FROM ai_chat_messages
          WHERE session_id = ?
            AND role = 'user'
        ) = 1
    `).run(normalizeSessionTitle(message.content), message.session_id, message.session_id)
  }

  return mapMessageRow(db.prepare('SELECT * FROM ai_chat_messages WHERE id=?').get(id) as AiChatMessageRow)
}

export function deleteAiChatSession(db: Database, id: string): void {
  db.prepare('DELETE FROM ai_chat_messages WHERE session_id=?').run(id)
  db.prepare('DELETE FROM ai_chat_sessions WHERE id=?').run(id)
}
