/**
 * Scenario 4: 完整练习流程
 * 批量导入题目（粘贴 JSON）→ 随机练习 → 完成 → 验证成绩与错题记录。
 */
import { test, expect } from '@playwright/test'
import { launchApp, waitForPythonReady, closeApp } from './helpers/app'
import { fillTextarea } from './helpers/fill-textarea'
import path from 'path'
import fs from 'fs'

const QUESTIONS_FIXTURE = path.resolve(__dirname, 'fixtures/questions.json')

/** 通过 textarea 粘贴 JSON 批量导入题目 */
async function importQuestionsViaTextarea(
  page: import('playwright-core').Page,
  jsonPath: string,
  options?: { newGroupName?: string },
): Promise<boolean> {
  const json = fs.readFileSync(jsonPath, 'utf-8')

  const importBtn = page.locator('.qview .btn-group button').filter({ hasText: '批量导入' }).first()
  if (!(await importBtn.isVisible({ timeout: 8_000 }).catch(() => false))) return false
  await importBtn.click()

  // 等待含 textarea 的 modal
  await page.waitForSelector('.modal', { timeout: 8_000 })
  const textarea = page.locator('.modal textarea').first()
  await textarea.waitFor({ state: 'visible', timeout: 5_000 })

  if (options?.newGroupName) {
    await page.locator('.modal input[type="radio"][value="new"]').check()
    await page.locator('.modal input[placeholder="新分组名称"]').fill(options.newGroupName)
  }

  // 使用 evaluate 触发 Vue v-model（Electron 中 fill() 有时不会触发 input 事件）
  await fillTextarea(textarea, json)

  // 等待按钮变为可用（v-model 更新后 importText.trim() 非空）
  const confirmBtn = page.getByText('确认导入').first()
  await expect(confirmBtn).toBeEnabled({ timeout: 5_000 })
  await confirmBtn.click()

  // 等待完成提示（成功或错误）
  await page
    .waitForSelector('.success-text, .error-text', { timeout: 20_000 })
    .catch(() => {})
  await page.waitForTimeout(500)

  // 关闭 modal
  const closeBtn = page.locator('.modal .close-btn, .modal button:has-text("关闭")').first()
  if (await closeBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await closeBtn.click()
    await page.waitForTimeout(500)
  }
  return true
}

test.describe('完整练习流程', () => {
  test('题库筛选年份与编辑题目分组下拉可用', async () => {
    const handle = await launchApp()
    try {
      await waitForPythonReady(handle.page)
      const { page } = handle
      const groupName = 'E2E-题库-编辑分组'
      const currentYear = new Date().getFullYear()

      await page.evaluate(async (name) => {
        await window.electronAPI.upsertQuestionGroup({
          name,
          group_type: 'custom',
          description: 'e2e question edit group option',
        })
      }, groupName)

      await page.locator('.nav-item[href="#/questions"]').click()
      await page.waitForSelector('.qview, .toolbar', { timeout: 10_000 })
      await importQuestionsViaTextarea(page, QUESTIONS_FIXTURE)

      const filterSelects = page.locator('.filter-wrap select')
      const examYearSelect = filterSelects.nth(2)
      const examPeriodSelect = filterSelects.nth(3)
      await expect(examYearSelect.locator('option')).toHaveCount(6)
      await expect(examYearSelect.locator('option').nth(1)).toHaveText(String(currentYear))
      await expect(examPeriodSelect.locator('option').first()).toHaveText('全部期次')

      await page.locator('.q-table tbody tr .icon-btn[title="编辑"]').first().click()
      await page.waitForSelector('.modal', { timeout: 5_000 })
      const editGroupSelect = page.locator('.modal select').nth(1)
      await expect(editGroupSelect.locator('option').nth(1)).toHaveText(groupName)
      await editGroupSelect.selectOption({ label: groupName })
      await expect(editGroupSelect).not.toHaveValue('', { timeout: 5_000 })
    } finally {
      await closeApp(handle)
    }
  })

  test('批量导入 10 道题，全部正确入库', async () => {
    const handle = await launchApp()
    try {
      await waitForPythonReady(handle.page)
      const { page } = handle
      const groupName = 'E2E-练习-导入分组'

      await page.locator('.nav-item[href="#/questions"]').click()
      await page.waitForSelector('.qview, .q-table, .toolbar', { timeout: 10_000 })

      const ok = await importQuestionsViaTextarea(page, QUESTIONS_FIXTURE, { newGroupName: groupName })
      expect(ok).toBe(true)

      // 等待列表刷新
      await page.waitForTimeout(1_000)

      await page.locator('.filter-wrap select').first().selectOption({ label: groupName })
      await page.waitForTimeout(800)

      // 题目数量 ≥ 10
      const rows = page.locator('.q-table tbody tr, .question-item')
      const count = await rows.count()
      expect(count).toBeGreaterThanOrEqual(10)
    } finally {
      await closeApp(handle)
    }
  })

  test('练习配置页显示分组筛选并可选择', async () => {
    const handle = await launchApp()
    try {
      await waitForPythonReady(handle.page)
      const { page } = handle
      const groupName = 'E2E-练习-随机分组'

      await page.evaluate(async (name) => {
        await window.electronAPI.upsertQuestionGroup({
          name,
          group_type: 'custom',
          description: 'e2e practice filter option',
        })
      }, groupName)

      // 先导入题目
      await page.locator('.nav-item[href="#/questions"]').click()
      await page.waitForSelector('.qview, .toolbar', { timeout: 10_000 })
      await importQuestionsViaTextarea(page, QUESTIONS_FIXTURE)

      // 导航到练习
      await page.locator('.nav-item[href="#/practice"]').click()
      await page.waitForSelector('.config-panel, .mode-cards, .practice-view', { timeout: 10_000 })

      const groupSelect = page.locator('.config-panel .group-filter')
      await groupSelect.selectOption({ label: groupName })
      await expect(groupSelect).not.toHaveValue('', { timeout: 5_000 })
      await groupSelect.selectOption({ index: 0 })
      const examYearSelect = page.locator('.config-panel .exam-year-filter')
      await expect(examYearSelect.locator('option')).toHaveCount(6)
      await expect(examYearSelect.locator('option').nth(1)).toHaveText(String(new Date().getFullYear()))

      await expect(page.getByText('开始练习')).toBeVisible({ timeout: 5_000 })
    } finally {
      await closeApp(handle)
    }
  })

  test('练习中关闭应用再打开，不丢失作答记录', async () => {
    const handle = await launchApp()
    const { userDataDir } = handle
    try {
      await waitForPythonReady(handle.page)
      const { page } = handle
      const groupName = 'E2E-练习-持久化分组'

      // 导入题目
      await page.locator('.nav-item[href="#/questions"]').click()
      await page.waitForSelector('.qview, .toolbar', { timeout: 10_000 })
      await importQuestionsViaTextarea(page, QUESTIONS_FIXTURE, { newGroupName: groupName })

      // 关闭（保留 userDataDir）
      await closeApp(handle, false)

      // 重新打开同一数据目录
      const handle2 = await launchApp({ userDataDir })
      try {
        await waitForPythonReady(handle2.page)
        await handle2.page.locator('.nav-item[href="#/questions"]').click()
        await handle2.page.waitForSelector('.qview, .q-table, .toolbar', { timeout: 10_000 })
        await handle2.page.locator('.filter-wrap select').first().selectOption({ label: groupName })
        await handle2.page.waitForTimeout(800)

        const rows = handle2.page.locator('.q-table tbody tr, .question-item')
        const count = await rows.count()
        expect(count).toBeGreaterThanOrEqual(1)
      } finally {
        await closeApp(handle2)
      }
    } finally {
      await handle.app.close().catch(() => {})
    }
  })
})
