/**
 * Vector store embedding-routing tests.
 *
 * Verifies vector-store now generates embeddings through getEmbeddingService()
 * (not getOllamaService directly), and that indexTranscript fails GRACEFULLY:
 * when embeddings come back null there is NO per-chunk console.error flood —
 * only the single "Indexed N chunks" summary line is logged.
 *
 * ../database is stubbed in-memory; ../embeddings/embedding-provider is mocked.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock: ../database — minimal sql.js-like stub (run / exec).
// ---------------------------------------------------------------------------
const mockRun = vi.fn()
vi.mock('../database', () => ({
  getDatabase: () => ({
    run: (...args: unknown[]) => mockRun(...args),
    exec: () => []
  })
}))

// ---------------------------------------------------------------------------
// Mock: ../embeddings/embedding-provider — controllable generateEmbedding.
// ---------------------------------------------------------------------------
const mockGenerateEmbedding = vi.fn(async (_text: string) => [0.1, 0.2] as number[] | null)
vi.mock('../embeddings/embedding-provider', () => ({
  getEmbeddingService: () => ({
    generateEmbedding: (text: string) => mockGenerateEmbedding(text)
  })
}))

// Safety net: if vector-store still reached for ollama directly, fail loudly.
const mockOllamaGenerate = vi.fn(async () => {
  throw new Error('vector-store must not call getOllamaService().generateEmbedding')
})
vi.mock('../ollama', () => ({
  getOllamaService: () => ({ generateEmbedding: mockOllamaGenerate })
}))

import { VectorStore } from '../vector-store'

beforeEach(() => {
  vi.clearAllMocks()
  mockGenerateEmbedding.mockResolvedValue([0.1, 0.2])
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('VectorStore — embedding routing', () => {
  it('addDocument generates the embedding via the embedding service', async () => {
    const store = new VectorStore()
    const id = await store.addDocument('hello', { chunkIndex: 0, recordingId: 'rec-1' })

    expect(mockGenerateEmbedding).toHaveBeenCalledWith('hello')
    expect(mockOllamaGenerate).not.toHaveBeenCalled()
    expect(id).not.toBeNull()
  })
})

describe('VectorStore — graceful indexing when embeddings are null', () => {
  it('logs no per-chunk error flood, only the single summary line', async () => {
    mockGenerateEmbedding.mockResolvedValue(null)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const store = new VectorStore()
    const transcript = 'One thing. Two thing. Three thing. Four thing. Five thing.'
    const indexed = await store.indexTranscript(transcript, { recordingId: 'rec-2' })

    expect(indexed).toBe(0)
    // No per-chunk "Failed to generate embedding" flood.
    expect(errorSpy).not.toHaveBeenCalled()
    // Exactly one summary line.
    const summaryCalls = logSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('Indexed')
    )
    expect(summaryCalls).toHaveLength(1)

    errorSpy.mockRestore()
    logSpy.mockRestore()
  })
})
