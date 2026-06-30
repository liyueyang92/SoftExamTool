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
} as const
