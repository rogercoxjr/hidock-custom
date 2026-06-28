import { ipcMain } from 'electron'
import { getConfig } from '../services/config'

// Correct Ollama Cloud API base is api.ollama.com, not the website ollama.com.
const OLLAMA_TAGS_URL = 'https://api.ollama.com/api/tags'
const OLLAMA_CHAT_URL = 'https://api.ollama.com/api/chat'
const FETCH_TIMEOUT_MS = 30 * 1000 // 30 s per handler call (spec Task 6 Step 2)

export function registerSummarizationHandlers(): void {
  // List available Ollama Cloud models — GET /api/tags with Bearer auth.
  // Runs in the main process because the renderer cannot make cross-origin
  // requests to ollama.com without a CORS issue.
  ipcMain.handle(
    'summarization:listModels',
    async (_event, apiKeyArg?: unknown): Promise<{ success: boolean; models?: string[]; error?: string }> => {
      // Prefer the key passed from the (possibly unsaved) Settings form so first-run
      // setup works before Save; fall back to the persisted key for legacy callers.
      const apiKey =
        typeof apiKeyArg === 'string' && apiKeyArg.length > 0 ? apiKeyArg : getConfig().summarization?.ollamaCloudApiKey ?? ''
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
    async (_event, apiKeyArg?: unknown, modelArg?: unknown): Promise<{ success: boolean; error?: string }> => {
      // Prefer the key/model passed from the (possibly unsaved) Settings form so the
      // Test button reflects what the user typed, not stale saved values; fall back to
      // the persisted config for legacy callers.
      const config = getConfig()
      const apiKey =
        typeof apiKeyArg === 'string' && apiKeyArg.length > 0 ? apiKeyArg : config.summarization?.ollamaCloudApiKey ?? ''
      const model =
        typeof modelArg === 'string' && modelArg.length > 0 ? modelArg : config.summarization?.ollamaCloudModel ?? ''
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
