export const IPC = {
  // Phase 0
  PYTHON_STATUS: 'python:status',
  PING: 'ping',
  // Phase 1 — DB
  DB_STATUS: 'db:status',
  // Phase 1 — Tasks
  TASK_CREATE: 'task:create',
  TASK_GET: 'task:get',
  TASK_CANCEL: 'task:cancel',
  // Phase 1 — Progress push (main → renderer)
  TASK_PROGRESS: 'task:progress',
  // Phase 1 — App settings
  APP_GET_SETTINGS: 'app:getSettings',
  APP_SET_SETTING: 'app:setSetting',

  // Phase 2 — Questions
  QUESTION_QUERY: 'question:query',
  QUESTION_SEARCH: 'question:search',
  QUESTION_INSERT: 'question:insert',
  QUESTION_BATCH_INSERT: 'question:batchInsert',
  QUESTION_UPDATE: 'question:update',
  QUESTION_DELETE: 'question:delete',
  QUESTION_TOGGLE_FAVORITE: 'question:toggleFavorite',
  QUESTION_GET_STATS: 'question:getStats',

  // Phase 2 — Practice
  PRACTICE_START: 'practice:start',
  PRACTICE_SUBMIT_ANSWER: 'practice:submitAnswer',
  PRACTICE_END: 'practice:end',
  PRACTICE_GET_WRONG: 'practice:getWrong',

  // Phase 3 — Documents
  DOC_LIST: 'doc:list',
  DOC_IMPORT: 'doc:import',
  DOC_DELETE: 'doc:delete',
  DOC_GET_CHUNKS: 'doc:getChunks',

  // Phase 3 — AI
  AI_GENERATE_QUESTIONS: 'ai:generateQuestions',
  AI_GRADE_ESSAY: 'ai:gradeEssay',
  AI_TEST_CONNECTION: 'ai:testConnection',
  AI_GET_CONFIG: 'ai:getConfig',
  AI_SET_CONFIG: 'ai:setConfig',
} as const
