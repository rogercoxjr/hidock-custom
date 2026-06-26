/**
 * Vector store embedding-routing tests.
 *
 * Verifies vector-store generates embeddings through getEmbeddingService()
 * (not getOllamaService directly), and that indexTranscript fails GRACEFULLY:
 * when embeddings come back null there is NO per-chunk console.error flood —
 * only the single "Indexed N chunks" summary line is logged.
 *
 * Backed by the REAL better-sqlite3 database (canonical harness — see
 * database.boot.test.ts): a fresh HIDOCK_DATA_ROOT temp dir + vi.resetModules()
 * per test, then initializeFileStorage() + initializeDatabase() so VectorStore's
 * real db.prepare()/db.exec() persistence path runs against a real DB. Only the
 * embedding provider (external dependency) is mocked; ../ollama is mocked purely
 * as a fail-loud safety net to prove vector-store never reaches it directly.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Mock: ../embeddings/embedding-provider — controllable generateEmbedding.
// Hoisted so the spies are reachable from the (hoisted) vi.mock factory.
// ---------------------------------------------------------------------------
const { mockGenerateEmbedding, mockOllamaGenerate } = vi.hoisted(() => ({
  mockGenerateEmbedding: vi.fn(async (_text: string) => [0.1, 0.2] as number[] | null),
  mockOllamaGenerate: vi.fn(async () => {
    throw new Error('vector-store must not call getOllamaService().generateEmbedding')
  })
}))

vi.mock('../embeddings/embedding-provider', () => ({
  getEmbeddingService: () => ({
    generateEmbedding: (text: string) => mockGenerateEmbedding(text)
  })
}))

// Safety net: if vector-store still reached for ollama directly, fail loudly.
vi.mock('../ollama', () => ({
  getOllamaService: () => ({ generateEmbedding: mockOllamaGenerate })
}))

let dir: string

beforeEach(() => {
  vi.resetModules()
  mockGenerateEmbedding.mockReset()
  mockOllamaGenerate.mockReset()
  mockGenerateEmbedding.mockResolvedValue([0.1, 0.2])
  mockOllamaGenerate.mockRejectedValue(
    new Error('vector-store must not call getOllamaService().generateEmbedding')
  )
  dir = mkdtempSync(join(tmpdir(), 'hidock-vstore-'))
  process.env.HIDOCK_DATA_ROOT = dir
})

afterEach(async () => {
  const { closeDatabase } = await import('../database')
  try { closeDatabase() } catch { /* ignore */ }
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
  delete process.env.HIDOCK_DATA_ROOT
})

/** Boot the real file storage + database, then return a real-DB-backed VectorStore. */
async function bootStore() {
  const { initializeFileStorage } = await import('../file-storage')
  const db = await import('../database')
  await initializeFileStorage()
  await db.initializeDatabase()
  const { VectorStore } = await import('../vector-store')
  const store = new VectorStore()
  // initialize() creates the vector_embeddings table on the real DB so the
  // addDocument INSERT (db.prepare(...).run(...)) has a table to write into.
  await store.initialize()
  return store
}

describe('VectorStore — embedding routing', () => {
  it('addDocument generates the embedding via the embedding service', async () => {
    const store = await bootStore()
    const id = await store.addDocument('hello', { chunkIndex: 0, recordingId: 'rec-1' })

    expect(mockGenerateEmbedding).toHaveBeenCalledWith('hello')
    expect(mockOllamaGenerate).not.toHaveBeenCalled()
    expect(id).not.toBeNull()
  })
})

describe('VectorStore — graceful indexing when embeddings are null', () => {
  it('logs no per-chunk error flood, only the single summary line', async () => {
    mockGenerateEmbedding.mockResolvedValue(null)
    const store = await bootStore()

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

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
