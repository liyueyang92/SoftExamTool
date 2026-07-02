/**
 * Scenario 2: PDF 导入
 * 验证 PDF 文件选择 -> 导入确认 -> 文档库出现条目/重复导入命中缓存。
 */
import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForPythonReady, closeApp } from './helpers/app'
import path from 'path'

const SAMPLE_PDF = path.resolve(__dirname, 'fixtures/sample.pdf')

async function openImportModal(page: Page) {
  const importBtn = page
    .getByText('导入 PDF')
    .or(page.getByText('上传文档'))
    .or(page.getByText('+ 导入'))
    .first()
  await importBtn.click({ timeout: 10_000 })

  const modal = page.locator('.import-modal')
  await expect(modal).toBeVisible({ timeout: 10_000 })
  await expect(modal.getByText('确认导入')).toBeVisible({ timeout: 10_000 })
  return modal
}

async function confirmImport(page: Page) {
  const modal = await openImportModal(page)
  await modal.getByText('确认导入').click({ timeout: 10_000 })
  return modal
}

test.describe('PDF 导入', () => {
  test('导入 PDF 后文档库出现条目', async () => {
    const handle = await launchApp()
    try {
      await waitForPythonReady(handle.page)
      const { page } = handle

      await page.locator('.nav-item[href="#/documents"]').click()
      await page.waitForURL(/documents/, { timeout: 5_000 }).catch(() => {})
      await page.waitForSelector('.doc-list, .empty-tip, .upload-btn, button', { timeout: 8_000 })

      await handle.app.evaluate(
        ({ dialog }, pdfPath) => {
          dialog.showOpenDialog = async () => ({
            canceled: false,
            filePaths: [pdfPath],
          })
        },
        SAMPLE_PDF,
      )

      const modal = await confirmImport(page)
      await expect(modal).toBeHidden({ timeout: 15_000 })

      const items = page.locator('.doc-item, .document-item, .doc-list tbody tr')
      await expect.poll(async () => await items.count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
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

      await handle.app.evaluate(
        ({ dialog }, pdfPath) => {
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [pdfPath] })
        },
        SAMPLE_PDF,
      )

      const firstModal = await confirmImport(page)
      await expect(firstModal).toBeHidden({ timeout: 15_000 })

      const items = page.locator('.doc-item, .document-item, .doc-list tbody tr')
      await expect.poll(async () => await items.count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
      const countAfterFirst = await items.count()

      await handle.app.evaluate(
        ({ dialog }, pdfPath) => {
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [pdfPath] })
        },
        SAMPLE_PDF,
      )

      const secondModal = await confirmImport(page)
      await expect(secondModal.locator('.error-text')).toContainText('MD5', { timeout: 15_000 })

      const countAfterSecond = await items.count()
      expect(countAfterSecond).toBe(countAfterFirst)
    } finally {
      await closeApp(handle)
    }
  })
})
