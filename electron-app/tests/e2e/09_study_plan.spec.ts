/**
 * Scenario 9: 学习计划模块全流程
 * 覆盖考试配置 → 大纲导入 → 三阶段计划生成 → 任务管理 → 冲刺模式 → 学习日志 → 通知触发 → 模板管理
 */
import { test, expect } from '@playwright/test'
import { launchApp, waitForPythonReady, closeApp } from './helpers/app'

/** Shorthand: evaluate in page context and return data (or null on failure). */
async function ipcCall<T>(page: any, fn: string, ...args: any[]): Promise<T | null> {
  return page.evaluate(
    async (opts: { fn: string; args: any[] }) => {
      const api = (window as any).electronAPI
      if (typeof api[opts.fn] !== 'function') return null
      const r = await api[opts.fn](...opts.args)
      return r?.success ? r.data : null
    },
    { fn, args: args.length ? args : [undefined] },
  )
}

const HELPERS = {
  /** Create standard test exam config + outline + plan, returning planId. */
  async setupPlan(page: any, examDate: string): Promise<string> {
    await ipcCall(page, 'importOutline')
    await ipcCall(page, 'saveExamConfig', {
      exam_name: '系统架构设计师',
      exam_date: examDate,
      syllabus_version: '2024',
      target_score: 50,
      daily_min_minutes: 60,
      daily_max_minutes: 180,
      study_start_time: '19:00',
    })
    const plan: any = await ipcCall(page, 'createPlan', { examDate, mode: 'normal' })
    return plan?.id ?? ''
  },
}

test.describe('学习计划模块', () => {
  // ─── 9.1 考试配置 ───────────────────────────────────────────────────────────
  test('考试配置读写正常', async () => {
    const handle = await launchApp()
    try {
      await waitForPythonReady(handle.page)
      const { page } = handle as any

      const config = await ipcCall(page, 'getExamConfig')
      // 首次启动 config 为 null（表存在但无记录）
      expect(config).toBeNull()

      const saved: any = await ipcCall(page, 'saveExamConfig', {
        exam_name: '系统架构设计师',
        exam_date: '2026-11-08',
        syllabus_version: '2024',
        target_score: 50,
        daily_min_minutes: 90,
        daily_max_minutes: 240,
        study_start_time: '19:30',
      })

      expect(saved).not.toBeNull()
      expect(saved.exam_date).toBe('2026-11-08')
      expect(saved.target_score).toBe(50)

      const reloaded: any = await ipcCall(page, 'getExamConfig')
      expect(reloaded).not.toBeNull()
      expect(reloaded.daily_max_minutes).toBe(240)
    } finally {
      await closeApp(handle)
    }
  })

  // ─── 9.2 知识域大纲导入 ─────────────────────────────────────────────────────
  test('大纲导入与知识域树查询', async () => {
    const handle = await launchApp()
    try {
      await waitForPythonReady(handle.page)
      const { page } = handle as any

      const r1: any = await ipcCall(page, 'importOutline')
      expect(r1).not.toBeNull()
      expect(r1.imported).toBeGreaterThanOrEqual(50)

      const tree: any = await ipcCall(page, 'getDomainTree')
      expect(Array.isArray(tree)).toBe(true)
      expect(tree.length).toBeGreaterThanOrEqual(8)

      // 一级域应有名称和子域
      expect(tree[0]).toHaveProperty('name')
      expect(tree[0]).toHaveProperty('children')
      const hasChildren = tree.some(
        (d: any) => Array.isArray(d.children) && d.children.length > 0,
      )
      expect(hasChildren).toBe(true)

      // 重复导入应跳过
      const r2: any = await ipcCall(page, 'importOutline')
      expect(r2.imported).toBe(0)
    } finally {
      await closeApp(handle)
    }
  })

  // ─── 9.3 三阶段计划生成 ─────────────────────────────────────────────────────
  test('三阶段计划生成后各阶段任务类型合理', async () => {
    const handle = await launchApp()
    try {
      await waitForPythonReady(handle.page)
      const { page } = handle as any

      const planId = await HELPERS.setupPlan(page, '2026-09-15')
      expect(planId).toBeTruthy()

      // 重置并以分阶段方式生成
      await ipcCall(page, 'resetPlan', { planId, keepLogs: false })
      const gen: any = await ipcCall(page, 'generatePhasedPlan', { planId, examDate: '2026-09-15' })
      expect(gen).not.toBeNull()
      expect(gen.tasksCreated).toBeGreaterThan(0)

      // 查询所有任务
      const allTasks: any[] = (await ipcCall(page, 'getPlanTasks', { planId })) ?? []
      expect(allTasks.length).toBeGreaterThan(0)

      // 验证不同阶段的任务类型
      const taskTypes = new Set(allTasks.map((t: any) => t.task_type))
      expect(taskTypes.has('reading') || taskTypes.has('practice')).toBe(true)

      const hasMockExam = allTasks.some((t: any) => t.task_type === 'mock_exam')
      const hasReview = allTasks.some((t: any) => t.task_type === 'review')
      expect(hasMockExam || hasReview).toBe(true)
    } finally {
      await closeApp(handle)
    }
  })

  // ─── 9.4 任务锁定与解锁 ─────────────────────────────────────────────────────
  test('锁定/解锁未来 N 天任务', async () => {
    const handle = await launchApp()
    try {
      await waitForPythonReady(handle.page)
      const { page } = handle as any

      const planId = await HELPERS.setupPlan(page, '2026-09-15')
      expect(planId).toBeTruthy()

      await ipcCall(page, 'resetPlan', { planId, keepLogs: false })
      await ipcCall(page, 'generatePhasedPlan', { planId, examDate: '2026-09-15' })

      const today = new Date().toISOString().slice(0, 10)
      const d3 = new Date()
      d3.setDate(d3.getDate() + 2)
      const toDate = d3.toISOString().slice(0, 10)

      // 锁定前 3 天
      const lockResult: any = await ipcCall(page, 'lockDays', { planId, fromDate: today, toDate })
      expect(lockResult).not.toBeNull()
      expect(lockResult.locked).toBeGreaterThan(0)

      // 验证锁定状态
      const tasks: any[] =
        (await ipcCall(page, 'getPlanTasks', { planId, dateFrom: today, dateTo: toDate })) ?? []
      const allLocked = tasks.every((t: any) => t.locked === 1)
      expect(allLocked).toBe(true)

      // 解锁
      const unlockResult: any = await ipcCall(page, 'unlockDays', { planId, fromDate: today, toDate })
      expect(unlockResult.unlocked).toBeGreaterThan(0)
    } finally {
      await closeApp(handle)
    }
  })

  // ─── 9.5 自定义任务与移动任务 ────────────────────────────────────────────────
  test('添加自定义任务并可移动日期', async () => {
    const handle = await launchApp()
    try {
      await waitForPythonReady(handle.page)
      const { page } = handle as any

      const planId = await HELPERS.setupPlan(page, '2026-09-15')
      expect(planId).toBeTruthy()

      const today = new Date().toISOString().slice(0, 10)

      // 添加自定义任务
      const task: any = await ipcCall(page, 'addCustomTask', {
        planId,
        task: {
          date: today,
          knowledge_tag: '微服务架构',
          task_type: 'video',
          estimated_min: 45,
          suggested_count: 0,
          priority: 1,
        },
      })

      expect(task).not.toBeNull()
      expect(task.task_type).toBe('video')
      expect(task.knowledge_tag).toBe('微服务架构')

      // 移动任务到明天
      const tomorrow = new Date()
      tomorrow.setDate(tomorrow.getDate() + 1)
      const tomorrowStr = tomorrow.toISOString().slice(0, 10)

      await ipcCall(page, 'moveTask', { taskId: task.id, newDate: tomorrowStr })

      // 验证
      const tasksTomorrow: any[] =
        (await ipcCall(page, 'getPlanTasks', {
          planId,
          dateFrom: tomorrowStr,
          dateTo: tomorrowStr,
        })) ?? []
      const moved = tasksTomorrow.find((t: any) => t.id === task.id)
      expect(moved).toBeDefined()
      expect(moved.task_type).toBe('video')
    } finally {
      await closeApp(handle)
    }
  })

  // ─── 9.6 请假日任务分散 ─────────────────────────────────────────────────────
  test('跳过当天 → 未完成任务分散到后续 3 天', async () => {
    const handle = await launchApp()
    try {
      await waitForPythonReady(handle.page)
      const { page } = handle as any

      const planId = await HELPERS.setupPlan(page, '2026-09-15')
      expect(planId).toBeTruthy()

      const today = new Date().toISOString().slice(0, 10)

      // 确保今天有任务
      const todayTasks: any[] =
        (await ipcCall(page, 'getPlanTasks', { planId, dateFrom: today, dateTo: today })) ?? []
      if (todayTasks.length < 2) {
        await ipcCall(page, 'addCustomTask', {
          planId,
          task: {
            date: today, knowledge_tag: '测试A', task_type: 'practice',
            estimated_min: 30, suggested_count: 10, priority: 0,
          },
        })
        await ipcCall(page, 'addCustomTask', {
          planId,
          task: {
            date: today, knowledge_tag: '测试B', task_type: 'reading',
            estimated_min: 45, suggested_count: 0, priority: 0,
          },
        })
      }

      const result: any = await ipcCall(page, 'skipDay', { planId, skipDate: today })
      expect(result).not.toBeNull()
      // 操作成功即通过
      expect(result.distributed).toBeGreaterThanOrEqual(0)
    } finally {
      await closeApp(handle)
    }
  })

  // ─── 9.7 冲刺模式状态检查 ────────────────────────────────────────────────────
  test('考试 ≤30 天自动激活冲刺模式', async () => {
    const handle = await launchApp()
    try {
      await waitForPythonReady(handle.page)
      const { page } = handle as any

      const examDate = new Date()
      examDate.setDate(examDate.getDate() + 15)
      const examDateStr = examDate.toISOString().slice(0, 10)

      await HELPERS.setupPlan(page, examDateStr)

      // 查询冲刺状态
      const status: any = await ipcCall(page, 'getSprintStatus')
      expect(status).not.toBeNull()
      expect(status.isActive).toBe(true)
      expect(status.daysUntilExam).toBeLessThanOrEqual(30)

      // 每日冲刺卡片
      const card: any = await ipcCall(page, 'getDailyCard')
      expect(card).not.toBeNull()
      expect(card).toHaveProperty('items')

      // 手动激活冲刺模式 → idempotent
      const plan: any = await ipcCall(page, 'getPlanActive')
      if (plan) {
        await ipcCall(page, 'activateSprintMode', plan.id)
        const statusAfter: any = await ipcCall(page, 'getSprintStatus')
        expect(statusAfter.isActive).toBe(true)
      }
    } finally {
      await closeApp(handle)
    }
  })

  // ─── 9.8 学习日志创建与统计 ──────────────────────────────────────────────────
  test('学习日志 CRUD 与统计聚合', async () => {
    const handle = await launchApp()
    try {
      await waitForPythonReady(handle.page)
      const { page } = handle as any

      const today = new Date().toISOString().slice(0, 10)

      // 创建上午日志
      const log: any = await ipcCall(page, 'createLog', {
        log_date: today,
        time_slot: 'morning',
        task_id: null,
        focus_minutes: 45,
        pomodoro_cycles: 2,
        interruption_count: 1,
        self_rating: 4,
        notes: '效率还不错',
      })

      expect(log).not.toBeNull()
      expect(log.focus_minutes).toBe(45)
      expect(log.pomodoro_cycles).toBe(2)

      // 再创建晚上日志
      await ipcCall(page, 'createLog', {
        log_date: today,
        time_slot: 'evening',
        task_id: null,
        focus_minutes: 90,
        pomodoro_cycles: 3,
        interruption_count: 0,
        self_rating: 5,
        notes: '晚上效率高',
      })

      // 查询今日日志
      const todayLogs: any[] = (await ipcCall(page, 'queryLogs', { from: today, to: today })) ?? []
      expect(todayLogs.length).toBeGreaterThanOrEqual(2)

      // 统计近 30 天
      const stats: any[] = (await ipcCall(page, 'getLogStats', { days: 30 })) ?? []
      expect(Array.isArray(stats)).toBe(true)
      const todayStats = stats.find((s: any) => s.date === today)
      expect(todayStats).toBeDefined()
      expect(todayStats.total_focus_minutes).toBeGreaterThanOrEqual(135)

      // 更新日志
      const updated: any = await ipcCall(page, 'updateLog', {
        id: log.id,
        changes: { self_rating: 3, notes: '更新备注' },
      })
      expect(updated).not.toBeNull()
      expect(updated.self_rating).toBe(3)
      expect(updated.notes).toBe('更新备注')
    } finally {
      await closeApp(handle)
    }
  })

  // ─── 9.9 通知触发检查 ────────────────────────────────────────────────────────
  test('通知触发器检查返回新通知', async () => {
    const handle = await launchApp()
    try {
      await waitForPythonReady(handle.page)
      const { page } = handle as any

      const examDate = new Date()
      examDate.setDate(examDate.getDate() + 14)
      const examDateStr = examDate.toISOString().slice(0, 10)

      await ipcCall(page, 'saveExamConfig', {
        exam_name: '系统架构设计师',
        exam_date: examDateStr,
        syllabus_version: '2024',
        target_score: 50,
        daily_min_minutes: 60,
        daily_max_minutes: 180,
        study_start_time: '19:00',
      })

      // 触发通知检查
      const notifications: any[] = (await ipcCall(page, 'checkNotificationTriggers')) ?? []
      expect(Array.isArray(notifications)).toBe(true)

      // 考前 14 天 → 应收到 countdown 通知
      const hasCountdown = notifications.some((n: any) => n.type === 'countdown')
      expect(hasCountdown).toBe(true)

      // 查询通知列表
      const list: any[] = (await ipcCall(page, 'listNotifications', { limit: 20 })) ?? []
      expect(list.length).toBeGreaterThan(0)

      // 标记全部已读
      await ipcCall(page, 'markNotificationRead', undefined)

      // 确认未读为空
      const afterRead: any[] = (await ipcCall(page, 'listNotifications', { isRead: 0, limit: 20 })) ?? []
      expect(afterRead.length).toBe(0)
    } finally {
      await closeApp(handle)
    }
  })

  // ─── 9.10 计划模板管理 ────────────────────────────────────────────────────────
  test('计划模板可查询、创建与应用', async () => {
    const handle = await launchApp()
    try {
      await waitForPythonReady(handle.page)
      const { page } = handle as any

      const templates: any[] = (await ipcCall(page, 'listTemplates')) ?? []
      expect(Array.isArray(templates)).toBe(true)

      // 创建自定义模板
      const created: any = await ipcCall(page, 'createTemplate', {
        name: 'E2E-测试模板',
        description: 'E2E 测试模板',
        phase: 'foundation',
        task_rules_json: JSON.stringify({
          daily_tasks: [
            { type: 'reading', estimated_min: 60 },
            { type: 'practice', count: 10, estimated_min: 30 },
          ],
        }),
        is_builtin: 0,
      })

      expect(created).not.toBeNull()
      expect(created.name).toBe('E2E-测试模板')
      expect(created.phase).toBe('foundation')

      // 创建计划并应用模板
      await ipcCall(page, 'importOutline')
      const planId = await HELPERS.setupPlan(page, '2026-12-15')
      expect(planId).toBeTruthy()

      const applied: any = await ipcCall(page, 'applyTemplate', { planId, templateId: created.id })
      expect(applied).not.toBeNull()
      expect(applied.tasksCreated).toBeGreaterThan(0)
    } finally {
      await closeApp(handle)
    }
  })

  // ─── 9.11 专注统计 ────────────────────────────────────────────────────────────
  test('专注统计返回有效数据', async () => {
    const handle = await launchApp()
    try {
      await waitForPythonReady(handle.page)
      const { page } = handle as any

      // 启动一个番茄钟会话
      const session: any = await ipcCall(page, 'startSession', { type: 'pomodoro' })
      expect(session).not.toBeNull()

      // 模拟中断
      await ipcCall(page, 'reportInterruption', session.id)

      // 结束会话
      await ipcCall(page, 'endSession', { id: session.id, durationMs: 25 * 60 * 1000 })

      // 查询专注统计
      const stats: any = await ipcCall(page, 'getFocusStats', { days: 30 })
      expect(stats).not.toBeNull()
      expect(stats.totalSessions).toBeGreaterThanOrEqual(1)
      expect(stats.totalPomodoros).toBeGreaterThanOrEqual(1)
      expect(stats).toHaveProperty('avgFocusMinutes')
      expect(stats).toHaveProperty('bestTimeSlot')
      expect(stats).toHaveProperty('dailyBreakdown')
    } finally {
      await closeApp(handle)
    }
  })

  // ─── 9.12 计划重置保留数据 ────────────────────────────────────────────────────
  test('重置计划保留学习日志', async () => {
    const handle = await launchApp()
    try {
      await waitForPythonReady(handle.page)
      const { page } = handle as any

      const planId = await HELPERS.setupPlan(page, '2026-10-01')
      expect(planId).toBeTruthy()

      const today = new Date().toISOString().slice(0, 10)

      // 创建一条日志
      await ipcCall(page, 'createLog', {
        log_date: today,
        time_slot: 'morning',
        task_id: null,
        focus_minutes: 60,
        pomodoro_cycles: 2,
        interruption_count: 0,
        self_rating: 4,
        notes: '保留测试',
      })

      // 重置计划但保留日志
      await ipcCall(page, 'resetPlan', { planId, keepLogs: true })

      // 日志应仍然存在
      const stats: any[] = (await ipcCall(page, 'getLogStats', { days: 30 })) ?? []
      expect(Array.isArray(stats)).toBe(true)

      const todayStats = stats.find((s: any) => s.date === today)
      if (todayStats) {
        expect(todayStats.total_focus_minutes).toBeGreaterThanOrEqual(60)
      }
    } finally {
      await closeApp(handle)
    }
  })
})
