import type { AppConfig } from '../config'
import { ProviderAuthError, ProviderRateLimitError } from '../provider-errors'
import type { OllamaChatMessage } from '../ollama'
import type { ChatProvider, ChatProviderOptions } from './chat-provider'

const OLLAMA_TIMEOUT_MS = 5 * 60 * 1000 // spec §7.4
const OLLAMA_CLOUD_URL = 'https://ollama.com/api/chat'

interface OllamaCloudChatResponse {
  message?: { content?: string }
}

function buildBody(
  model: string,
  messages: OllamaChatMessage[],
  opts?: ChatProviderOptions
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: false
  }

  if (opts?.temperature !== undefined || opts?.maxTokens !== undefined) {
    const options: Record<string, unknown> = {}
    if (opts.temperature !== undefined) {
      options.temperature = opts.temperature
    }
    if (opts.maxTokens !== undefined) {
      options.num_predict = opts.maxTokens
    }
    body.options = options
  }

  return body
}

export function createOllamaCloudChat(config: AppConfig): ChatProvider {
  if (!config.summarization.ollamaCloudApiKey) {
    throw new Error('Ollama Cloud API key not configured — add it in Settings → Summarization') // §7.1 verbatim
  }

  const apiKey = config.summarization.ollamaCloudApiKey
  const model = config.summarization.ollamaCloudModel

  async function send(messages: OllamaChatMessage[], opts?: ChatProviderOptions): Promise<string | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS)

    const onAbort = () => controller.abort()
    opts?.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      const response = await fetch(OLLAMA_CLOUD_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody(model, messages, opts)),
        signal: controller.signal
      })

      if (response.status === 404) {
        throw new Error(`Ollama Cloud model '${model}' not found — choose a new model in Settings → Summarization`)
      }
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After')
        throw new ProviderRateLimitError('Ollama Cloud', retryAfter ? Number(retryAfter) * 1000 : undefined)
      }
      if (response.status === 401) {
        throw new ProviderAuthError('Ollama Cloud')
      }
      if (!response.ok) {
        throw new Error(`Ollama Cloud chat failed (HTTP ${response.status}): ${(await response.text()).slice(0, 200)}`)
      }

      const json = (await response.json()) as OllamaCloudChatResponse
      return json.message?.content ?? ''
    } finally {
      clearTimeout(timer)
      opts?.signal?.removeEventListener('abort', onAbort)
    }
  }

  return {
    async chat(messages: OllamaChatMessage[], opts?: ChatProviderOptions): Promise<string | null> {
      return send(messages, opts)
    },

    async generate(prompt: string, opts?: ChatProviderOptions): Promise<string | null> {
      return send([{ role: 'user', content: prompt }], opts)
    }
  }
}
