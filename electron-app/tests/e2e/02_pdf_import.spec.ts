/**
 * Scenario 2: PDF 导入
 * 验证 PDF 文件选择 → 解析进度推进 → 文档库出现条目。
 */
import { test, expect } from '@playwright/test'
import { launchApp, waitForPythonReady, closeApp } from './helpers/app'
import path from 'path'

const SAMPLE_PDF = path.resolve(__dirname, 'fixtures/sample.pdf')

test.describe('PDF 导入', () => {
  test('导入 PDF 后文档库出现条目', async () => {
    const handle = await launchApp()
    try {
      await waitForPythonReady(handle.page)
      const { page } = handle

      // 导航到文档库
      await page.locator('.nav-item[href="#/documents"]').click()
      await page.waitForURL(/documents/, { timeout: 5_000 }).catch(() => {
        // hash 路由不触发 waitForURL，改等选择器
      })
      await page.waitForSelector('.doc-list, .empty-tip, .upload-btn, button', { timeout: 8_000 })

      // 拦截文件选择对话框，注入测试 PDF 路径
      await handle.app.evaluate(
        ({ dialog }, pdfPath) => {
          dialog.showOpenDialog = async () => ({
            canceled: false,
            filePaths: [pdfPath],
          })
        },
        SAMPLE_PDF,
      )

      // 点击导入/上传按钮
      const importBtn = page
        .getByText('导入 PDF')
        .or(page.getByText('上传文档'))
        .or(page.getByText('+ 导入'))
        .first()
      await importBtn.click({ timeout: 10_000 })

      // 等待进度完成或文档条目出现（最多 60 秒）
      await page
        .waitForSelector('.doc-item, .document-item, tr.doc-row', { timeout: 60_000 })
        .catch(async () => {
          // 进度可能以 toast 或进度条形式出现，等待其消失
          await page.waitForTimeout(3_000)
        })

      // 断言文档库至少有一条记录
      const items = page.locator('.doc-item, .document-item, .doc-list tbody tr')
      const count = await items.count()
      expect(count).toBeGreaterThanOrEqual(1)
    } finally {
      await closeApp(handle)
    }
  })

  test('重复导入同一 PDF 命中 MD5 缓存，不新增条目', async () => {
    const handle = await launchApp()
    try {
      await waitForPythonReady(handle.page)
      const { page } = handle

      await page.locator('.nav-item[href="#/documents"]').click()
      await page.waitForSelector('.doc-list, .empty-tip, button', { timeout: 8_000 })

      // 拦截两次文件选择
      await handle.app.evaluate(
        ({ dialog }, pdfPath) => {
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [pdfPath] })
        },
        SAMPLE_PDF,
      )

      const clickImport = async () => {
        const btn = page
          .getByText('导入 PDF')
          .or(page.getByText('上传文档'))
          .or(page.getByText('+ 导入'))
          .first()
        await btn.click({ timeout: 10_000 })
        await page.waitForTimeout(3_000)
      }

      await clickImport()
      const countAfterFirst = await page
        .locator('.doc-item, .document-item, .doc-list tbody tr')
        .count()

      // 第二次导入
      await handle.app.evaluate(
        ({ dialog }, pdfPath) => {
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [pdfPath] })
        },
        SAMPLE_PDF,
      )
      await clickImport()
      const countAfterSecond = await page
        .locator('.doc-item, .document-item, .doc-list tbody tr')
        .count()

      expect(countAfterSecond).toBe(countAfterFirst)
    } finally {
      await closeApp(handle)
    }
  })
})
