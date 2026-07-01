export const IPC = {
  // Phase 0
  PYTHON_STATUS: 'python:status',
  GET_PYTHON_STATUS: 'python:getStatus',
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
  DOC_PICK_FILE: 'doc:pickFile',
  DOC_IMPORT: 'doc:import',
  DOC_PREVIEW: 'doc:preview',
  DOC_DELETE: 'doc:delete',
  DOC_GET_CHUNKS: 'doc:getChunks',

  // Phase 3 — AI
  AI_GENERATE_QUESTIONS: 'ai:generateQuestions',
  AI_GRADE_ESSAY: 'ai:gradeEssay',
  AI_TEST_CONNECTION: 'ai:testConnection',
  AI_GET_CONFIG: 'ai:getConfig',
  AI_SET_CONFIG: 'ai:setConfig',

  // Phase 5 — Crawler
  CRAWLER_LIST_RULES: 'crawler:listRules',
  CRAWLER_UPSERT_RULE: 'crawler:upsertRule',
  CRAWLER_DELETE_RULE: 'crawler:deleteRule',
  CRAWLER_TEST: 'crawler:test',
  CRAWLER_RUN: 'crawler:run',
  CRAWLER_LIST_RUNS: 'crawler:listRuns',

  // Phase 5 — Knowledge Graph
  GRAPH_BUILD: 'graph:build',

  // Phase 5 — Essay
  ESSAY_LIST: 'essay:list',
  ESSAY_CREATE: 'essay:create',
  ESSAY_GET: 'essay:get',
  ESSAY_UPDATE_SECTION: 'essay:updateSection',
  ESSAY_UPDATE_META: 'essay:updateMeta',
  ESSAY_SAVE_VERSION: 'essay:saveVersion',
  ESSAY_LIST_VERSIONS: 'essay:listVersions',
  ESSAY_RESTORE_VERSION: 'essay:restoreVersion',
  ESSAY_DELETE: 'essay:delete',
  ESSAY_LIST_MATERIALS: 'essay:listMaterials',
  ESSAY_UPSERT_MATERIAL: 'essay:upsertMaterial',
  ESSAY_DELETE_MATERIAL: 'essay:deleteMaterial',
  ESSAY_AI_SUGGEST: 'essay:aiSuggest',

  // Phase 5 — AI Chat with RAG
  AI_CHAT: 'ai:chat',

  // Phase 4 — Study Plans
  PLAN_GET_ACTIVE: 'plan:getActive',
  PLAN_CREATE: 'plan:create',
  PLAN_DELETE: 'plan:delete',
  PLAN_GET_TASKS: 'plan:getTasks',
  PLAN_UPDATE_TASK: 'plan:updateTask',
  PLAN_GET_STATS: 'plan:getStats',
  PLAN_GET_CALENDAR: 'plan:getCalendar',
  PLAN_ADAPT: 'plan:adapt',

  // Phase 4 — Study Sessions
  SESSION_START: 'session:start',
  SESSION_END: 'session:end',
  SESSION_GET_TODAY: 'session:getToday',

  // Phase 6 — Achievements
  ACHIEVEMENT_LIST: 'achievement:list',
  ACHIEVEMENT_CHECK: 'achievement:check',

  // Phase 6 — Backup & Restore
  BACKUP_CREATE: 'backup:create',
  BACKUP_LIST: 'backup:list',
  BACKUP_RESTORE: 'backup:restore',
  BACKUP_DELETE: 'backup:delete',
} as const
