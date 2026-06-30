import { startMockAIServer } from './helpers/mock-server'

declare global {
  // eslint-disable-next-line no-var
  var __MOCK_AI_CLOSE__: () => void
}

export default async function globalSetup(): Promise<void> {
  const { port, close } = await startMockAIServer()
  process.env.MOCK_AI_PORT = String(port)
  global.__MOCK_AI_CLOSE__ = close
  console.log(`[E2E] Mock AI server started on port ${port}`)
}
