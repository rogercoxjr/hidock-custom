import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getConfig } from '../../main/services/config'
import { BadRequestError } from './_errors'

const OLLAMA_TAGS_URL = 'https://ollama.com/api/tags'
const OLLAMA_CHAT_URL = 'https://ollama.com/api/chat'
const FETCH_TIMEOUT_MS = 30 * 1000

const testConnectionBody = z.object({
  apiKey: z.string().optional(),
  model: z.string().optional()
})

const listModelsQuery = z.object({
  apiKey: z.string().optional()
})

export async function registerSummarization(app: FastifyInstance): Promise<void> {
  // GET /api/summarization/models — list available Ollama Cloud models
  // Runs server-side because the browser cannot make cross-origin requests
  // to ollama.com without CORS issues.
  app.get('/api/summarization/models', { preHandler: [app.requireAuth] }, async (req) => {
    const q = listModelsQuery.parse(req.query)
    const apiKey =
      typeof q.apiKey === 'string' && q.apiKey.length > 0
        ? q.apiKey
        : getConfig().summarization?.ollamaCloudApiKey ?? ''

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
        throw new BadRequestError(`Failed to list models (HTTP ${res.status}): ${text}`)
      }
      const json = (await res.json()) as { models?: Array<{ name: string }> }
      const models = (json.models ?? []).map((m) => m.name)
      return { success: true, models }
    } catch (err) {
      if (err instanceof BadRequestError) throw err
      throw new BadRequestError(err instanceof Error ? err.message : 'Unknown error listing models')
    } finally {
      clearTimeout(timer)
    }
  })

  // POST /api/summarization/test-connection — test the Ollama Cloud connection
  // POSTs a 1-token chat with the configured model and classifies the result.
  app.post(
    '/api/summarization/test-connection',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req) => {
      const body = testConnectionBody.parse(req.body)
      const config = getConfig()
      const apiKey =
        typeof body.apiKey === 'string' && body.apiKey.length > 0
          ? body.apiKey
          : config.summarization?.ollamaCloudApiKey ?? ''
      const model =
        typeof body.model === 'string' && body.model.length > 0
          ? body.model
          : config.summarization?.ollamaCloudModel ?? ''

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
          throw new BadRequestError(
            'Ollama Cloud API key was rejected — re-enter it in Settings → Summarization'
          )
        }
        if (res.status === 404) {
          throw new BadRequestError(
            `Ollama Cloud model '${model}' not found — choose a new model in Settings → Summarization`
          )
        }
        if (res.status === 429) {
          throw new BadRequestError(
            'Ollama Cloud quota exceeded — check your plan or wait before retrying'
          )
        }
        if (!res.ok) {
          const text = (await res.text()).slice(0, 200)
          throw new BadRequestError(`Test connection failed (HTTP ${res.status}): ${text}`)
        }
        return { success: true }
      } catch (err) {
        if (err instanceof BadRequestError) throw err
        throw new BadRequestError(err instanceof Error ? err.message : 'Unknown error testing connection')
      } finally {
        clearTimeout(timer)
      }
    }
  )
}
