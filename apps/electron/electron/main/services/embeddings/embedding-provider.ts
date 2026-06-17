/**
 * Embedding Provider
 *
 * Routes embedding generation on config.embeddings.provider:
 *   - 'ollama' => delegate to OllamaService (existing local behavior).
 *   - 'openai' => POST https://api.openai.com/v1/embeddings with Bearer auth.
 *
 * GRACEFUL FAILURE: on missing key / fetch rejection / non-ok response the
 * OpenAI branch returns null, never throws, and logs AT MOST ONE concise
 * warning per service instance (the `warned` flag) — no per-call error flood.
 */

import { getConfig } from '../config'
import { getOllamaService } from '../ollama'

const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings'
const DEFAULT_OPENAI_MODEL = 'text-embedding-3-small'

interface OpenAIEmbeddingResponse {
  data: Array<{ embedding: number[] }>
}

class EmbeddingService {
  // One concise warning per instance — prevents the per-chunk error flood.
  private warned = false

  private warnOnce(message: string): void {
    if (this.warned) return
    this.warned = true
    console.warn(`[Embeddings] ${message}`)
  }

  async generateEmbedding(text: string): Promise<number[] | null> {
    const config = getConfig()
    const provider = config.embeddings?.provider

    if (provider === 'ollama') {
      return getOllamaService().generateEmbedding(text)
    }

    // Default: OpenAI.
    const apiKey = config.transcription?.openaiApiKey
    if (!apiKey) {
      this.warnOnce('OpenAI API key not configured — skipping embedding generation')
      return null
    }

    const model = config.embeddings?.openaiModel || DEFAULT_OPENAI_MODEL

    try {
      const response = await fetch(OPENAI_EMBEDDINGS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({ model, input: text })
      })

      if (!response.ok) {
        this.warnOnce(`OpenAI embeddings request failed (${response.status} ${response.statusText})`)
        return null
      }

      const data: OpenAIEmbeddingResponse = await response.json()
      const embedding = data.data?.[0]?.embedding
      if (!embedding) {
        this.warnOnce('OpenAI embeddings response missing data[0].embedding')
        return null
      }
      return embedding
    } catch (err) {
      this.warnOnce(`OpenAI embeddings request error: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  async generateEmbeddings(texts: string[]): Promise<(number[] | null)[]> {
    const embeddings: (number[] | null)[] = []
    for (const text of texts) {
      embeddings.push(await this.generateEmbedding(text))
    }
    return embeddings
  }
}

// Singleton instance
let embeddingInstance: EmbeddingService | null = null

export function getEmbeddingService(): EmbeddingService {
  if (!embeddingInstance) {
    embeddingInstance = new EmbeddingService()
  }
  return embeddingInstance
}

export { EmbeddingService }
