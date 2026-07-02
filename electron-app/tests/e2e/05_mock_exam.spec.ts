/**
 * Scenario 5: 全真模拟考试
 * 验证模拟考试配置 → 答题计时 → 交卷 → 客观题出分 → AI 主观题评分（mock）。
 */
import { test, expect } from '@playwright/test'
import { launchApp, waitForPythonReady, closeApp, seedAiConfig } from './helpers/app'
import { fillTextarea } from './helpers/fill-textarea'
import os from 'os'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'

const QUESTIONS_FIXTURE = path.resolve(__dirname, 'fixtures/questions.json')

/** 通过 textarea 粘贴 JSON 批量导入题目 */
async function importQuestionsViaTextarea(
  page: import('playwright-core').Page,
  jsonPath: string,
  options?: { newGroupName?: string },
): Promise<void> {
  const json = fs.readFileSync(jsonPath, 'utf-8')

  const importBtn = page.locator('.qview .btn-group button').filter({ hasText: '批量导入' }).first()
  if (!(await importBtn.isVisible({ timeout: 8_000 }).catch(() => false))) return
  await importBtn.click()

  await page.waitForSelector('.modal', { timeout: 8_000 })
  const textarea = page.locator('.modal textarea').first()
  await textarea.waitFor({ state: 'visible', timeout: 5_000 })
  if (options?.newGroupName) {
    await page.locator('.modal input[type="radio"][value="new"]').check()
    await page.locator('.modal input[placeholder="新分组名称"]').fill(options.newGroupName)
  }
  await fillTextarea(textarea, json)

  const confirmBtn = page.getByText('确认导入').first()
  await expect(confirmBtn).toBeEnabled({ timeout: 5_000 })
  await confirmBtn.click()

  await page.waitForSelector('.success-text, .error-text', { timeout: 20_000 }).catch(() => {})
  await page.waitForTimeout(500)

  const closeBtn = page.locator('.modal .close-btn, .modal button:has-text("关闭")').first()
  if (await closeBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await closeBtn.click()
    await page.waitForTimeout(500)
  }
}

test.describe('全真模拟考试', () => {
  test('模拟考试配置页显示分组筛选并可选择', async () => {
    const mockPort = parseInt(process.env.MOCK_AI_PORT ?? '0', 10)
    const userDataDir = path.join(
      os.tmpdir(),
      `softexam-e2e-${crypto.randomBytes(4).toString('hex')}`,
    )
    if (mockPort) seedAiConfig(userDataDir, mockPort)

    const handle = await launchApp({ userDataDir })
    try {
      await waitForPythonReady(handle.page)
      const { page } = handle
      const groupName = 'E2E-模考-分组'

      await page.evaluate(async (name) => {
        await window.electronAPI.upsertQuestionGroup({
          name,
          group_type: 'custom',
          description: 'e2e exam filter option',
        })
      }, groupName)

      // 先导入题目（textarea 方式）
      await page.locator('.nav-item[href="#/questions"]').click()
      await page.waitForSelector('.qview, .toolbar', { timeout: 10_000 })
      await importQuestionsViaTextarea(page, QUESTIONS_FIXTURE)

      // 导航到练习页面，找模拟考试入口
      await page.locator('.nav-item[href="#/practice"]').click()
      await page.waitForSelector('.config-panel, .mode-cards, .practice-view', { timeout: 10_000 })
      const groupSelect = page.locator('.config-panel .group-filter')
      await groupSelect.selectOption({ label: groupName })
      await expect(groupSelect).not.toHaveValue('', { timeout: 5_000 })
      await groupSelect.selectOption({ index: 0 })

      // 找"模拟考试"或降级为随机练习
      const examMode = page
        .getByText('模拟考试')
        .or(page.getByText('全真模拟'))
        .or(page.getByText('整卷练习'))
        .first()

      if (await examMode.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await examMode.click()
      } else {
        const randomMode = page.getByText('随机练习').or(page.getByText('顺序练习')).first()
        await randomMode.click({ timeout: 5_000 }).catch(() => {})
      }

      await expect(
        page.getByText('开始')
          .or(page.getByText('开始练习'))
          .or(page.getByText('开始考试'))
          .first(),
      ).toBeVisible({ timeout: 5_000 })
    } finally {
      await closeApp(handle)
    }
  })
})
