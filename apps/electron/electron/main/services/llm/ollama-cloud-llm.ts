import type { AppConfig } from '../config'
import type { LlmProvider } from './llm-provider'
import { ProviderRateLimitError, ProviderAuthError } from '../provider-errors'

const OLLAMA_TIMEOUT_MS = 5 * 60 * 1000 // spec §7.4
const OLLAMA_CLOUD_URL = 'https://ollama.com/api/chat'

export function createOllamaCloudLlm(config: AppConfig): LlmProvider {
  if (!config.summarization.ollamaCloudApiKey) {
    throw new Error('Ollama Cloud API key not configured — add it in Settings → Summarization') // §7.1 verbatim
  }
  const apiKey = config.summarization.ollamaCloudApiKey
  const model = config.summarization.ollamaCloudModel

  return {
    async generate(prompt: string, opts?: { json?: boolean }): Promise<string> {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS)
      try {
        const res = await fetch(OLLAMA_CLOUD_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
            ...(opts?.json ? { format: 'json' } : {})
          }),
          signal: controller.signal
        })
        if (res.status === 404) {
          throw new Error(`Ollama Cloud model '${model}' not found — choose a new model in Settings → Summarization`)
        }
        if (res.status === 429) {
          const retryAfter = res.headers.get('Retry-After')
          throw new ProviderRateLimitError('Ollama Cloud', retryAfter ? Number(retryAfter) * 1000 : undefined)
        }
        if (res.status === 401) throw new ProviderAuthError('Ollama Cloud')
        if (!res.ok) throw new Error(`Ollama Cloud chat failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`)
        const json = (await res.json()) as { message?: { content?: string } }
        return json.message?.content ?? ''
      } finally {
        clearTimeout(timer)
      }
    }
  }
}
