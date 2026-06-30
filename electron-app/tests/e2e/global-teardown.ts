export default async function globalTeardown(): Promise<void> {
  if (global.__MOCK_AI_CLOSE__) {
    global.__MOCK_AI_CLOSE__()
    console.log('[E2E] Mock AI server stopped')
  }
}
