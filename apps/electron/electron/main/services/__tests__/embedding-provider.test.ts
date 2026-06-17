/**
 * Embedding provider tests.
 *
 * Verifies getEmbeddingService() routes on config.embeddings.provider:
 *   - 'openai' => POSTs OpenAI /v1/embeddings with Bearer auth, parses
 *     data[0].embedding, model defaults to 'text-embedding-3-small'.
 *   - 'ollama' => delegates to OllamaService.generateEmbedding (existing behavior).
 *
 * Graceful failure (spec): on missing key / fetch rejection / non-ok the OpenAI
 * branch returns null, NEVER throws, and logs AT MOST ONE concise warning per
 * service instance (instance 'warned' flag) — no per-call console.error flood.
 *
 * global fetch is stubbed via vi.stubGlobal; ../config and ../ollama are mocked.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted controllable state — must exist before vi.mock factories.
// ---------------------------------------------------------------------------
const { shared } = vi.hoisted(() => ({
  shared: {
    config: {
      embeddings: {
        provider: 'openai' as 'openai' | 'ollama',
        ollamaBaseUrl: 'http://localhost:11434',
        ollamaModel: 'nomic-embed-text',
        openaiModel: 'text-embedding-3-small',
        chunkSize: 500,
        chunkOverlap: 50
      },
      transcription: {
        openaiApiKey: 'sk-test'
      }
    }
  }
}))

// ---------------------------------------------------------------------------
// Mock: ../config — getConfig returns the controllable shared.config.
// ---------------------------------------------------------------------------
vi.mock('../config', () => ({
  getConfig: () => shared.config
}))

// ---------------------------------------------------------------------------
// Mock: ../ollama — getOllamaService returns a spy generateEmbedding so the
// 'ollama' routing branch is observable without touching local Ollama.
// ---------------------------------------------------------------------------
const mockOllamaGenerate = vi.fn(async (_text: string) => [0.1, 0.2, 0.3] as number[] | null)
vi.mock('../ollama', () => ({
  getOllamaService: () => ({
    generateEmbedding: (text: string) => mockOllamaGenerate(text)
  })
}))

import { EmbeddingService, getEmbeddingService } from '../embeddings/embedding-provider'

function okResponse(embedding: number[]) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ data: [{ embedding }] })
  }
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  shared.config = {
    embeddings: {
      provider: 'openai',
      ollamaBaseUrl: 'http://localhost:11434',
      ollamaModel: 'nomic-embed-text',
      openaiModel: 'text-embedding-3-small',
      chunkSize: 500,
      chunkOverlap: 50
    },
    transcription: { openaiApiKey: 'sk-test' }
  }
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('EmbeddingService — openai branch', () => {
  it('returns the embedding from data[0].embedding', async () => {
    fetchMock.mockResolvedValueOnce(okResponse([0.5, 0.6, 0.7]))
    const svc = new EmbeddingService()
    const result = await svc.generateEmbedding('hello world')
    expect(result).toEqual([0.5, 0.6, 0.7])
  })

  it('POSTs the OpenAI endpoint with Bearer auth and the default model', async () => {
    fetchMock.mockResolvedValueOnce(okResponse([1, 2, 3]))
    const svc = new EmbeddingService()
    await svc.generateEmbedding('embed me')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/embeddings')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer sk-test')
    const body = JSON.parse(init.body)
    expect(body.model).toBe('text-embedding-3-small')
    expect(body.input).toBe('embed me')
  })

  it('generateEmbeddings maps each input to an embedding', async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse([1, 1]))
      .mockResolvedValueOnce(okResponse([2, 2]))
    const svc = new EmbeddingService()
    const results = await svc.generateEmbeddings(['a', 'b'])
    expect(results).toEqual([[1, 1], [2, 2]])
  })
})

describe('EmbeddingService — graceful failure', () => {
  it('missing key => null, warns at most once across calls, never fetches', async () => {
    shared.config.transcription.openaiApiKey = ''
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const svc = new EmbeddingService()

    expect(await svc.generateEmbedding('a')).toBeNull()
    expect(await svc.generateEmbedding('b')).toBeNull()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    warnSpy.mockRestore()
  })

  it('fetch rejection => null, warns at most once, never throws', async () => {
    fetchMock.mockRejectedValue(new Error('network down'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const svc = new EmbeddingService()

    expect(await svc.generateEmbedding('a')).toBeNull()
    expect(await svc.generateEmbedding('b')).toBeNull()

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('non-ok response => null, warns at most once', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({}) })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const svc = new EmbeddingService()

    expect(await svc.generateEmbedding('a')).toBeNull()
    expect(await svc.generateEmbedding('b')).toBeNull()

    expect(warnSpy).toHaveBeenCalledTimes(1)
    warnSpy.mockRestore()
  })
})

describe('getEmbeddingService — routing', () => {
  it("delegates to OllamaService when provider='ollama'", async () => {
    shared.config.embeddings.provider = 'ollama'
    const svc = new EmbeddingService()
    const result = await svc.generateEmbedding('via ollama')

    expect(mockOllamaGenerate).toHaveBeenCalledWith('via ollama')
    expect(result).toEqual([0.1, 0.2, 0.3])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("uses the OpenAI branch when provider='openai'", async () => {
    shared.config.embeddings.provider = 'openai'
    fetchMock.mockResolvedValueOnce(okResponse([9, 9]))
    const result = await getEmbeddingService().generateEmbedding('route me')

    expect(result).toEqual([9, 9])
    expect(mockOllamaGenerate).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
