import { ipcMain } from 'electron'
import { getConfig } from '../services/config'

const OLLAMA_TAGS_URL = 'https://ollama.com/api/tags'
const OLLAMA_CHAT_URL = 'https://ollama.com/api/chat'
const FETCH_TIMEOUT_MS = 30 * 1000 // 30 s per handler call (spec Task 6 Step 2)

export function registerSummarizationHandlers(): void {
  // List available Ollama Cloud models — GET /api/tags with Bearer auth.
  // Runs in the main process because the renderer cannot make cross-origin
  // requests to ollama.com without a CORS issue.
  ipcMain.handle(
    'summarization:listModels',
    async (): Promise<{ success: boolean; models?: string[]; error?: string }> => {
      const config = getConfig()
      const apiKey = config.summarization?.ollamaCloudApiKey ?? ''
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
      try {
        const res = await fetch(OLLAMA_TAGS_URL, {
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          signal: controller.signal
        })
        if (!res.ok) {
          const text = (await res.text()).slice(0, 200)
          return { success: false, error: `Failed to list models (HTTP ${res.status}): ${text}` }
        }
        const json = (await res.json()) as { models?: Array<{ name: string }> }
        const models = (json.models ?? []).map((m) => m.name)
        return { success: true, models }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error listing models'
        }
      } finally {
        clearTimeout(timer)
      }
    }
  )

  // Test the Ollama Cloud connection — POST a 1-token chat with the configured
  // model and classify the result: ok / key-rejected / model-not-found / quota.
  ipcMain.handle(
    'summarization:testConnection',
    async (): Promise<{ success: boolean; error?: string }> => {
      const config = getConfig()
      const apiKey = config.summarization?.ollamaCloudApiKey ?? ''
      const model = config.summarization?.ollamaCloudModel ?? ''
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
      try {
        const res = await fetch(OLLAMA_CHAT_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: 'ping' }],
            stream: false
          }),
          signal: controller.signal
        })
        if (res.status === 401) {
          return {
            success: false,
            error: 'Ollama Cloud API key was rejected — re-enter it in Settings → Summarization'
          }
        }
        if (res.status === 404) {
          return {
            success: false,
            error: `Ollama Cloud model '${model}' not found — choose a new model in Settings → Summarization`
          }
        }
        if (res.status === 429) {
          return {
            success: false,
            error: 'Ollama Cloud quota exceeded — check your plan or wait before retrying'
          }
        }
        if (!res.ok) {
          const text = (await res.text()).slice(0, 200)
          return { success: false, error: `Test connection failed (HTTP ${res.status}): ${text}` }
        }
        return { success: true }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error testing connection'
        }
      } finally {
        clearTimeout(timer)
      }
    }
  )
}
