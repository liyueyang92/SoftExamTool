/**
 * Lightweight mock for OpenAI-compatible AI API used during E2E tests.
 * Started once in global-setup, port stored in process.env.MOCK_AI_PORT.
 */
import http from 'http'

const MOCK_QUESTIONS = {
  questions: [
    {
      type: 'single',
      content: '以下哪种架构模式最适合高并发场景？',
      options: ['A. 单体架构', 'B. 微服务架构', 'C. SOA 架构', 'D. 管道-过滤器架构'],
      answer: 'B',
      explanation: '微服务架构可独立扩展各服务实例，适合高并发场景。',
      knowledge_tags: ['软件架构风格'],
      difficulty: 3,
    },
    {
      type: 'single',
      content: 'CAP 定理中，分布式系统最多同时满足几个属性？',
      options: ['A. 1 个', 'B. 2 个', 'C. 3 个', 'D. 不确定'],
      answer: 'B',
      explanation: 'CAP 定理指出，分布式系统在 C、A、P 三者中最多同时满足 2 个。',
      knowledge_tags: ['分布式系统'],
      difficulty: 3,
    },
    {
      type: 'single',
      content: '软件质量属性中，"可修改性"属于哪类？',
      options: ['A. 运行时质量属性', 'B. 非运行时质量属性', 'C. 用户可见属性', 'D. 以上都不是'],
      answer: 'B',
      explanation: '可修改性是在系统运行期间无法直接观察的非运行时质量属性。',
      knowledge_tags: ['质量属性'],
      difficulty: 2,
    },
    {
      type: 'single',
      content: 'UML 中，表示对象间协作关系的图是？',
      options: ['A. 类图', 'B. 用例图', 'C. 协作图', 'D. 状态图'],
      answer: 'C',
      explanation: '协作图（通信图）展示对象间的交互和消息传递关系。',
      knowledge_tags: ['UML建模'],
      difficulty: 2,
    },
    {
      type: 'single',
      content: '以下哪个不是面向对象的基本特性？',
      options: ['A. 封装', 'B. 继承', 'C. 多态', 'D. 事务'],
      answer: 'D',
      explanation: '面向对象三大特性是封装、继承、多态；事务是数据库概念。',
      knowledge_tags: ['面向对象方法'],
      difficulty: 1,
    },
  ],
}

const MOCK_SCORE = {
  total_score: 22,
  dimension_scores: [
    { dimension: '论点清晰度', score: 6, max_score: 8, comment: '论点明确，但论据可再充分。' },
    { dimension: '技术深度', score: 8, max_score: 10, comment: '技术方案描述详实，有一定深度。' },
    { dimension: '实践经验', score: 5, max_score: 7, comment: '项目实例较简单，建议增加数据支撑。' },
    { dimension: '语言规范', score: 3, max_score: 5, comment: '整体流畅，个别句子略显冗余。' },
  ],
  feedback: '本文结构完整，技术方案描述较好，建议在项目实践部分补充量化指标。',
  suggestions: ['在项目背景中补充系统规模（用户量、QPS 等）', '技术选型应对比至少一种备选方案'],
}

function buildOpenAIResponse(content: string): string {
  return JSON.stringify({
    id: 'mock-chatcmpl-001',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
  })
}

export function startMockAIServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json')
        res.statusCode = 200

        if (req.url?.startsWith('/crawler/static')) {
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.end(`
            <!doctype html>
            <html>
              <head><title>Crawler fixture</title><script>window.__should_not_run = true</script></head>
              <body>
                <main>
                  <article class="question-item">
                    <a class="detail-link" href="/crawler/detail/1">detail</a>
                    <h2 class="question-title">架构风格题</h2>
                    <p class="question-content">以下哪种架构风格适合高并发系统？</p>
                    <ul>
                      <li class="option">A. 单体架构</li>
                      <li class="option">B. 微服务架构</li>
                    </ul>
                    <strong class="answer">B</strong>
                    <div class="explanation">微服务可独立扩展。</div>
                  </article>
                </main>
              </body>
            </html>
          `)
          return
        }

        if (req.url?.startsWith('/crawler/detail/1')) {
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.end(`
            <article class="question-detail">
              <p class="question-content">详情页题干：微服务的主要优势是什么？</p>
              <span class="option">A. 独立部署</span>
              <span class="option">B. 必须单库</span>
              <strong class="answer">A</strong>
              <div class="explanation">服务可以独立部署和扩展。</div>
            </article>
          `)
          return
        }

        if (req.url?.startsWith('/crawler/api')) {
          res.end(JSON.stringify({
            items: [{
              title: 'API 题',
              content: 'CAP 定理最多同时满足几个属性？',
              options: ['A. 1', 'B. 2'],
              answer: 'B',
              explanation: '最多两个。',
              url: `http://127.0.0.1:${(server.address() as { port: number }).port}/crawler/api`,
            }],
          }))
          return
        }

        if (req.url?.startsWith('/crawler/feed')) {
          res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8')
          res.end(`<?xml version="1.0" encoding="UTF-8" ?>
            <rss version="2.0"><channel><title>Fixture Feed</title>
              <item><title>Feed 题</title><link>http://example.test/feed-q</link><description>Feed 导入内容</description></item>
            </channel></rss>`)
          return
        }

        if (req.url?.startsWith('/crawler/auth-login')) {
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.end(`
            <!doctype html>
            <html>
              <body>
                <p>Logging in fixture account...</p>
                <script>
                  document.cookie = 'fixture_session=ok; path=/';
                  setTimeout(() => { window.location.href = '/crawler/auth-dashboard'; }, 50);
                </script>
              </body>
            </html>
          `)
          return
        }

        if (req.url?.startsWith('/crawler/auth-dashboard')) {
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.end(`
            <!doctype html>
            <html>
              <body>
                <main class="fixture-dashboard">
                  <span class="user-avatar">fixture</span>
                  <a href="/crawler/static?page=1">question bank</a>
                </main>
              </body>
            </html>
          `)
          return
        }

        if (req.url?.startsWith('/crawler/validate')) {
          res.end(JSON.stringify({ ok: true, user: 'fixture' }))
          return
        }

        // Handle /v1/models (connection test)
        if (req.url === '/v1/models') {
          res.end(
            JSON.stringify({ data: [{ id: 'mock-gpt', object: 'model', owned_by: 'mock' }] }),
          )
          return
        }

        // Handle /v1/chat/completions
        if (req.url === '/v1/chat/completions') {
          let parsed: Record<string, unknown> = {}
          try {
            parsed = JSON.parse(body)
          } catch {
            // ignore parse errors
          }
          const messages = (parsed.messages as Array<{ role: string; content: string }>) || []
          const lastUserMsg = [...messages].reverse().find((m: { role: string; content: string }) => m.role === 'user')?.content ?? ''

          // Route by keyword in prompt
          if (lastUserMsg.includes('评分') || lastUserMsg.includes('score')) {
            res.end(buildOpenAIResponse(JSON.stringify(MOCK_SCORE)))
          } else {
            // Default: return question generation payload
            res.end(buildOpenAIResponse(JSON.stringify(MOCK_QUESTIONS)))
          }
          return
        }

        res.statusCode = 404
        res.end(JSON.stringify({ error: 'not found' }))
      })
    })

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({
        port: addr.port,
        close: () => server.close(),
      })
    })
  })
}
