/**
 * ollama-cloud-llm tests — auto-pipeline P3, Task 2 (spec §5.2, §7.1, §7.4).
 *
 * Verifies the Ollama Cloud LLM provider: key-missing guard (spec §7.1 verbatim),
 * happy path (Bearer header, format:json, model, response extraction), opts.json
 * falsy (no format key), typed 404/429/401 errors, and the 5-min AbortController
 * timeout (spec §7.4). global fetch is stubbed via vi.stubGlobal.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ProviderRateLimitError, ProviderAuthError } from '../provider-errors'

// Narrow config helper — only the summarization fields createOllamaCloudLlm reads.
function ollamaConfig(overrides: { ollamaCloudApiKey?: string; ollamaCloudModel?: string } = {}) {
  return {
    transcription: { provider: 'gemini', geminiApiKey: 'g-key', geminiModel: 'gemini-m' },
    summarization: {
      provider: 'ollama-cloud' as const,
      ollamaCloudApiKey: overrides.ollamaCloudApiKey ?? 'ok-x',
      ollamaCloudModel: overrides.ollamaCloudModel ?? 'gpt-oss:120b'
    }
  } as never
}

// Build a Response-like stub.
function fetchResponse(opts: {
  status?: number
  ok?: boolean
  jsonBody?: unknown
  textBody?: string
  retryAfter?: string
}) {
  const status = opts.status ?? 200
  const headers = new Map<string, string>()
  if (opts.retryAfter) headers.set('Retry-After', opts.retryAfter)
  return {
    status,
    ok: opts.ok ?? (status >= 200 && status < 300),
    headers: { get: (k: string) => headers.get(k) ?? null },
    json: async () => opts.jsonBody,
    text: async () => opts.textBody ?? ''
  }
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('createOllamaCloudLlm — construction', () => {
  it('throws the spec §7.1 verbatim message when the key is missing', async () => {
    const { createOllamaCloudLlm } = await import('../llm/ollama-cloud-llm')
    expect(() => createOllamaCloudLlm(ollamaConfig({ ollamaCloudApiKey: '' }))).toThrow(
      'Ollama Cloud API key not configured — add it in Settings → Summarization'
    )
  })
})

describe('createOllamaCloudLlm — happy path', () => {
  it('POSTs to https://ollama.com/api/chat with Bearer auth + json format and returns message.content', async () => {
    fetchMock.mockResolvedValueOnce(
      fetchResponse({ jsonBody: { message: { content: '{"summary":"s"}' } } })
    )
    const { createOllamaCloudLlm } = await import('../llm/ollama-cloud-llm')
    const llm = createOllamaCloudLlm(ollamaConfig())
    const result = await llm.generate('PROMPT', { json: true })

    expect(result).toBe('{"summary":"s"}')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://ollama.com/api/chat')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ok-x')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')

    const body = JSON.parse(init.body as string)
    expect(body.model).toBe('gpt-oss:120b')
    expect(body.messages).toEqual([{ role: 'user', content: 'PROMPT' }])
    expect(body.stream).toBe(false)
    expect(body.format).toBe('json') // opts.json=true → format key present
  })

  it('opts.json falsy → body has NO format key', async () => {
    fetchMock.mockResolvedValueOnce(
      fetchResponse({ jsonBody: { message: { content: 'plain text' } } })
    )
    const { createOllamaCloudLlm } = await import('../llm/ollama-cloud-llm')
    const llm = createOllamaCloudLlm(ollamaConfig())
    await llm.generate('PROMPT') // no opts.json

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect('format' in body).toBe(false)
  })
})

describe('createOllamaCloudLlm — error classification', () => {
  it('404 → plain Error with spec §7.1 verbatim message', async () => {
    fetchMock.mockResolvedValueOnce(fetchResponse({ status: 404, ok: false }))
    const { createOllamaCloudLlm } = await import('../llm/ollama-cloud-llm')
    const llm = createOllamaCloudLlm(ollamaConfig({ ollamaCloudModel: 'gpt-oss:120b' }))
    const err = await llm.generate('PROMPT').catch((e) => e)
    expect((err as Error).message).toBe(
      "Ollama Cloud model 'gpt-oss:120b' not found — choose a new model in Settings → Summarization"
    )
    expect(err).not.toBeInstanceOf(ProviderRateLimitError)
  })

  it('429 with Retry-After → ProviderRateLimitError with retryAfterMs', async () => {
    fetchMock.mockResolvedValueOnce(
      fetchResponse({ status: 429, ok: false, retryAfter: '300' })
    )
    const { createOllamaCloudLlm } = await import('../llm/ollama-cloud-llm')
    const llm = createOllamaCloudLlm(ollamaConfig())
    const err = await llm.generate('PROMPT').catch((e) => e)
    expect(err).toBeInstanceOf(ProviderRateLimitError)
    expect((err as ProviderRateLimitError).provider).toBe('Ollama Cloud')
    expect((err as ProviderRateLimitError).retryAfterMs).toBe(300000)
  })

  it('401 → ProviderAuthError(Ollama Cloud)', async () => {
    fetchMock.mockResolvedValueOnce(fetchResponse({ status: 401, ok: false }))
    const { createOllamaCloudLlm } = await import('../llm/ollama-cloud-llm')
    const llm = createOllamaCloudLlm(ollamaConfig())
    const err = await llm.generate('PROMPT').catch((e) => e)
    expect(err).toBeInstanceOf(ProviderAuthError)
    expect((err as ProviderAuthError).provider).toBe('Ollama Cloud')
    expect((err as Error).message).toContain('Ollama Cloud API key was rejected')
  })
})

describe('createOllamaCloudLlm — timeout', () => {
  it('aborts after the 5-min timeout when fetch never resolves', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init.signal as AbortSignal
        signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted (timeout)')
          err.name = 'AbortError'
          reject(err)
        })
      })
    })
    const { createOllamaCloudLlm } = await import('../llm/ollama-cloud-llm')
    const llm = createOllamaCloudLlm(ollamaConfig())
    const promise = llm.generate('PROMPT')
    const assertion = expect(promise).rejects.toThrow(/abort/i)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1)
    await assertion
  })
})
