import Database from 'better-sqlite3-multiple-ciphers'
import { randomUUID } from 'crypto'
import { Question, queryQuestions, getWrongQuestions } from './questions'

export interface PracticeConfig {
  mode: 'random' | 'sequential' | 'wrong' | 'favorites'
  count: number
  groupId?: string
  groupType?: 'custom' | 'past_exam' | 'ai_generated' | 'crawled' | 'manual_import'
  examYear?: number
  examPeriod?: 'H1' | 'H2'
  sourceType?: 'manual' | 'ai_generated' | 'crawled' | 'imported'
  filterTags?: string[]
  filterTypes?: string[]
}

export interface PracticeSession {
  id: string
  questions: Question[]
  currentIndex: number
  answers: Record<string, { chosen: string; isCorrect: boolean; timeMs: number }>
  startedAt: number
  config: PracticeConfig
}

// In-memory store for active sessions
const activeSessions = new Map<string, PracticeSession>()

export function startPractice(db: Database.Database, config: PracticeConfig): { sessionId: string; questions: Question[] } {
  let questions: Question[] = []

  if (config.mode === 'wrong') {
    questions = getWrongQuestions(db, config.count)
  } else if (config.mode === 'favorites') {
    const result = queryQuestions(db, { is_favorite: true, pageSize: config.count })
    questions = result.items
  } else {
    const result = queryQuestions(db, {
      group_id: config.groupId,
      group_type: config.groupType,
      exam_year: config.examYear,
      exam_period: config.examPeriod,
      source_type: config.sourceType,
      knowledge_tag: config.filterTags?.[0],
      pageSize: 500,
    })
    questions = result.items
  }

  if (config.filterTypes?.length) {
    questions = questions.filter((q) => config.filterTypes!.includes(q.type))
  }
  if (config.filterTags?.length) {
    questions = questions.filter((q) => q.knowledge_tags.some((tag) => config.filterTags!.includes(tag)))
  }

  if (config.mode === 'random' || config.mode === 'wrong' || config.mode === 'favorites') {
    questions = [...questions].sort(() => Math.random() - 0.5)
  }
  questions = questions.slice(0, config.count)

  const sessionId = randomUUID()
  const session: PracticeSession = {
    id: sessionId,
    questions,
    currentIndex: 0,
    answers: {},
    startedAt: Date.now(),
    config
  }
  activeSessions.set(sessionId, session)

  db.prepare(`
    INSERT INTO practice_sessions (id, mode, filter_tags, filter_types, total_count)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    sessionId,
    config.mode,
    JSON.stringify(config.filterTags ?? []),
    JSON.stringify(config.filterTypes ?? []),
    questions.length
  )

  return { sessionId, questions }
}

export function submitAnswer(
  db: Database.Database,
  sessionId: string,
  questionId: string,
  chosen: string,
  timeMs: number
): { isCorrect: boolean; answer: string | null; explanation: string | null; nextIndex: number } {
  const session = activeSessions.get(sessionId)
  if (!session) throw Object.assign(new Error('Session not found'), { code: 'SESSION_NOT_FOUND' })

  const question = session.questions.find((q) => q.id === questionId)
  if (!question) throw Object.assign(new Error('Question not in session'), { code: 'INVALID_QUESTION' })

  let isCorrect = false
  if (question.type === 'single') {
    isCorrect = chosen.trim().toUpperCase() === (question.answer ?? '').trim().toUpperCase()
  } else if (question.type === 'multiple') {
    const chosenSet = new Set(chosen.split(',').map((s) => s.trim().toUpperCase()))
    const answerSet = new Set((question.answer ?? '').split(',').map((s) => s.trim().toUpperCase()))
    isCorrect = chosenSet.size === answerSet.size && [...chosenSet].every((c) => answerSet.has(c))
  }
  // case/essay: isCorrect stays false until AI grading or manual

  session.answers[questionId] = { chosen, isCorrect, timeMs }
  session.currentIndex = Math.min(session.currentIndex + 1, session.questions.length)

  db.prepare(`
    INSERT INTO answer_records (id, question_id, session_id, chosen, is_correct, time_spent_ms)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), questionId, sessionId, chosen, isCorrect ? 1 : 0, timeMs)

  return {
    isCorrect,
    answer: question.answer,
    explanation: question.explanation,
    nextIndex: session.currentIndex
  }
}

export function endPractice(
  db: Database.Database,
  sessionId: string
): { totalCount: number; correctCount: number; durationMs: number } {
  const session = activeSessions.get(sessionId)
  if (!session) throw Object.assign(new Error('Session not found'), { code: 'SESSION_NOT_FOUND' })

  const correctCount = Object.values(session.answers).filter((a) => a.isCorrect).length
  const durationMs = Date.now() - session.startedAt

  db.prepare('UPDATE practice_sessions SET correct_count = ?, ended_at = ? WHERE id = ?').run(
    correctCount,
    new Date().toISOString(),
    sessionId
  )

  activeSessions.delete(sessionId)

  return {
    totalCount: session.questions.length,
    correctCount,
    durationMs
  }
}

export function getSessionById(sessionId: string): PracticeSession | undefined {
  return activeSessions.get(sessionId)
}
