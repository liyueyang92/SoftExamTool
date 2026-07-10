import { test, expect } from '@playwright/test'
import { launchApp, waitForPythonReady, closeApp } from './helpers/app'

type IpcResult<T> = { success: true; data: T } | { success: false; error: { message: string } }

async function api<T>(page: import('playwright-core').Page, name: string, ...args: unknown[]): Promise<T> {
  const result = await page.evaluate(
    async ({ method, params }) => {
      const fn = window.electronAPI[method as keyof typeof window.electronAPI] as (...inner: unknown[]) => Promise<IpcResult<unknown>>
      return fn(...params)
    },
    { method: name, params: args },
  ) as IpcResult<T>
  if (!result.success) throw new Error(result.error.message)
  return result.data
}

function staticRule(port: string) {
  return {
    site_name: 'Crawler Fixture',
    adapter: 'http_rule',
    auth_required: 0,
    auth_mode: 'none',
    login_url: '',
    validate_url: `http://127.0.0.1:${port}/crawler/validate`,
    url_template: `http://127.0.0.1:${port}/crawler/static?page={page}`,
    item_selector: '.question-item',
    question_field: '.question-content',
    options_field: '.option',
    answer_field: '.answer',
    expl_field: '.explanation',
    rule_json: JSON.stringify({
      auth: {
        validate: {
          url: `http://127.0.0.1:${port}/crawler/validate`,
          success_statuses: [200],
          success_text: ['fixture'],
        },
      },
      list: {
        url_template: `http://127.0.0.1:${port}/crawler/static?page={page}`,
        item_selector: '.question-item',
        fields: {
          title: '.question-title',
          content: '.question-content',
          options: '.option',
          answer: '.answer',
          explanation: '.explanation',
        },
      },
      pagination: { type: 'page_param', max_pages: 1 },
      request: { delay_ms: 0 },
    }),
    version: 1,
    max_pages: 1,
    delay_ms: 0,
    is_enabled: 1,
  }
}

test.describe('crawler module', () => {
  test('static rule can inspect, test, run into review queue, and import', async () => {
    const handle = await launchApp()
    try {
      await waitForPythonReady(handle.page)
      const port = process.env.MOCK_AI_PORT
      expect(port).toBeTruthy()

      await handle.page.locator('.nav-item[href="#/crawler"]').click()
      await expect(handle.page.locator('.crawler-view')).toBeVisible()
      const runtimeButton = handle.page.locator('.runtime-pill')
      await expect(runtimeButton).toBeEnabled({ timeout: 65_000 })
      await runtimeButton.click()
      await expect(handle.page.locator('.runtime-message')).toBeVisible()
      await expect(handle.page.locator('.runtime-message')).not.toHaveText('')

      const runtime = await api<{ playwright_available: boolean; chromium_ready: boolean; message: string }>(
        handle.page,
        'getCrawlerRuntimeStatus',
      )
      expect(typeof runtime.playwright_available).toBe('boolean')
      expect(typeof runtime.chromium_ready).toBe('boolean')
      expect(runtime.message.length).toBeGreaterThan(0)

      const rule = await api<Record<string, unknown>>(handle.page, 'upsertCrawlerRule', staticRule(port!))
      expect(rule.id).toBeTruthy()

      const inspect = await api<{ html: string; nodes: Array<{ selector: string; text: string }> }>(
        handle.page,
        'inspectCrawlerLoad',
        { rule, url: `http://127.0.0.1:${port}/crawler/static?page=1` },
      )
      expect(inspect.html).toContain('question-item')
      expect(inspect.html).not.toContain('<script')
      expect(inspect.nodes.some((node) => node.selector.includes('question-content'))).toBe(true)

      const candidates = await api<{ candidates: Array<{ selector: string; kind?: string }> }>(
        handle.page,
        'suggestCrawlerSelector',
        { html: inspect.html, selector: '.question-content' },
      )
      expect(candidates.candidates.some((item) => item.kind === 'css')).toBe(true)
      expect(candidates.candidates.some((item) => item.kind === 'xpath')).toBe(true)

      const preview = await api<{ count: number; samples: unknown[] }>(
        handle.page,
        'inspectCrawlerPreview',
        { rule, html: inspect.html, url: `http://127.0.0.1:${port}/crawler/static?page=1` },
      )
      expect(preview.count).toBe(1)
      expect(preview.samples.length).toBeGreaterThan(0)

      const testResult = await api<{ count: number; samples: Array<{ content: string }> }>(
        handle.page,
        'testCrawl',
        { rule, test_url: `http://127.0.0.1:${port}/crawler/static?page=1` },
      )
      expect(testResult.count).toBe(1)
      expect(testResult.samples[0].content).toContain('高并发')

      const run = await api<{ taskId: string; runId: string }>(
        handle.page,
        'runCrawl',
        { ruleId: rule.id as string },
      )
      await expect.poll(async () => {
        const items = await api<unknown[]>(handle.page, 'listCrawlerReviewItems', { status: 'pending', runId: run.runId, limit: 10 })
        return items.length
      }, { timeout: 20_000 }).toBe(1)

      const reviewItems = await api<Array<{ id: string }>>(handle.page, 'listCrawlerReviewItems', { status: 'pending', runId: run.runId, limit: 10 })
      const imported = await api<{ count: number }>(handle.page, 'importCrawlerReviewItems', {
        ids: reviewItems.map((item) => item.id),
        new_group: { name: 'Crawler E2E', group_type: 'crawled' },
      })
      expect(imported.count).toBe(1)
    } finally {
      await closeApp(handle)
    }
  })

  test('api_json and feed_import adapters return normalized samples', async () => {
    const handle = await launchApp()
    try {
      await waitForPythonReady(handle.page)
      const port = process.env.MOCK_AI_PORT
      expect(port).toBeTruthy()

      const apiRule = {
        ...staticRule(port!),
        site_name: 'API Fixture',
        adapter: 'api_json',
        url_template: `http://127.0.0.1:${port}/crawler/api`,
        rule_json: JSON.stringify({
          api: {
            url: `http://127.0.0.1:${port}/crawler/api`,
            method: 'GET',
            items_path: 'items',
            fields: { title: 'title', content: 'content', options: 'options', answer: 'answer', explanation: 'explanation', source_url: 'url' },
          },
        }),
      }
      const apiResult = await api<{ count: number; samples: Array<{ content: string }> }>(
        handle.page,
        'testCrawl',
        { rule: apiRule, test_url: `http://127.0.0.1:${port}/crawler/api` },
      )
      expect(apiResult.count).toBe(1)
      expect(apiResult.samples[0].content).toContain('CAP')

      const feedRule = {
        ...staticRule(port!),
        site_name: 'Feed Fixture',
        adapter: 'feed_import',
        url_template: `http://127.0.0.1:${port}/crawler/feed`,
        rule_json: JSON.stringify({ feed: { url: `http://127.0.0.1:${port}/crawler/feed` } }),
      }
      const feedResult = await api<{ count: number; samples: Array<{ content: string }> }>(
        handle.page,
        'testCrawl',
        { rule: feedRule, test_url: `http://127.0.0.1:${port}/crawler/feed` },
      )
      expect(feedResult.count).toBe(1)
      expect(feedResult.samples[0].content).toContain('Feed')
    } finally {
      await closeApp(handle)
    }
  })

  test('auth window detects login success and captures session automatically', async () => {
    const handle = await launchApp()
    try {
      await waitForPythonReady(handle.page)
      const port = process.env.MOCK_AI_PORT
      expect(port).toBeTruthy()

      const rule = await api<Record<string, unknown>>(handle.page, 'upsertCrawlerRule', {
        ...staticRule(port!),
        site_name: 'Auth Fixture',
        auth_required: 1,
        auth_mode: 'manual_session',
        login_url: '',
        validate_url: '',
        rule_json: JSON.stringify({
          auth: {
            login_url: `http://127.0.0.1:${port}/crawler/auth-login`,
            success: {
              url_pattern: '/crawler/auth-dashboard',
              success_selector: '.user-avatar',
              required_cookies: ['fixture_session'],
              capture_delay_ms: 50,
            },
            validate: {
              url_pattern: '/crawler/auth-dashboard',
              required_cookies: ['fixture_session'],
            },
          },
          list: {
            url_template: `http://127.0.0.1:${port}/crawler/static?page={page}`,
            item_selector: '.question-item',
            fields: { content: '.question-content' },
          },
          pagination: { type: 'page_param', max_pages: 1 },
          request: { delay_ms: 0 },
        }),
      })

      const saved = await api<{ storage_meta: Record<string, unknown>; account_alias: string }>(
        handle.page,
        'startCrawlerAuth',
        { ruleId: rule.id as string, account_alias: 'fixture' },
      )
      expect(saved.account_alias).toBe('fixture')
      expect(saved.storage_meta.capture_mode).toBe('auto')
      expect(saved.storage_meta.captured_url).toContain('/crawler/auth-dashboard')
      expect(saved.storage_meta.matched_checks).toEqual(
        expect.arrayContaining(['url_pattern', 'success_selector', 'required_cookies']),
      )

      const validation = await api<{ valid: boolean; checks?: Array<{ name: string; valid: boolean }> }>(
        handle.page,
        'validateCrawlerSession',
        { ruleId: rule.id as string, account_alias: 'fixture' },
      )
      expect(validation.valid).toBe(true)
      expect(validation.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'required_cookies', valid: true }),
          expect.objectContaining({ name: 'url_pattern', valid: true }),
        ]),
      )
    } finally {
      await closeApp(handle)
    }
  })
})
