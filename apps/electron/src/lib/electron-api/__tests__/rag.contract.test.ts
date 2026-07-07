/**
 * rag.contract.test.ts — Layer-2 SDK↔route contract tests for the rag group.
 * See `contract-harness.ts` for the harness design.
 *
 * SKIPPED: chat() / summarizeMeeting() — both require a real chat-LLM provider round trip
 * (Gemini by default config) once a valid session/meeting has transcript context, which needs
 * live network + API keys. Not appropriate for a sandboxed, no-network contract-test CI run
 * (mirrors the existing electron/server/__tests__/transcripts.test.ts pattern of skipping the
 * live-provider path). `status`, `stats`, `cancel`, `removeLastMessages`, `clearSession`,
 * `search`, `chunks`, and `indexTranscript` are all covered because their server-side path
 * either never touches the network or gracefully no-ops when no embeddings/chat API key is
 * configured (see electron/main/services/embeddings/embedding-provider.ts:42-43 — with no
 * OpenAI key configured, `generateEmbedding` returns null *before* attempting a fetch).
 * `findActionItems()` is covered for the no-`meetingId` / empty-vector-store path. Note it
 * calls `getChatProvider()` *eagerly*, before checking whether it needs it — the default
 * 'gemini' provider throws synchronously with no API key configured — so that test seeds a
 * fake (non-network-touching) key via `saveConfig()` first; the empty vector store still means
 * `chatProvider.chat()` itself is never invoked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeRagGroup } from '../groups/rag'
import { http } from '../http'
import { makeContractApp, installFetchShim, closeContractApp, type ContractApp } from './contract-harness'

describe('rag contract', () => {
  let ctx: ContractApp
  const grp = makeRagGroup({ http })

  beforeEach(async () => {
    ctx = await makeContractApp()
    installFetchShim(ctx.app, ctx.cookie)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await closeContractApp(ctx)
  })

  it('status returns a RESULT envelope wrapping RAGStatus', async () => {
    const result = await grp.status()
    expect(result.success).toBe(true)
    if (result.success) {
      expect(typeof result.data.ollamaAvailable).toBe('boolean')
      expect(typeof result.data.documentCount).toBe('number')
    }
  })

  it('stats returns the bare stats object (RAW-THROW)', async () => {
    const result = await grp.stats()
    expect(typeof result.documentCount).toBe('number')
    expect(typeof result.meetingCount).toBe('number')
    expect(typeof result.sessionCount).toBe('number')
  })

  // FIXED: rag.cancel() now unwraps `POST /api/rag/cancel`'s `{ cancelled: boolean }` envelope,
  // so `.data` is the bare boolean its `Result<boolean>` return type promises.
  it('cancel unwraps {cancelled} — .data is the bare boolean', async () => {
    const result = await grp.cancel('no-such-session')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toBe(false)
    }
  })

  // FIXED: rag.removeLastMessages() now unwraps `POST .../trim`'s `{ removed: number }`
  // envelope, so `.data` is the bare number its `Result<number>` return type promises.
  it('removeLastMessages unwraps {removed} — .data is the bare number', async () => {
    const result = await grp.removeLastMessages('no-such-session', 3)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toBe(0)
    }
  })

  it('clearSession on a nonexistent session succeeds (no-op)', async () => {
    const result = await grp.clearSession('no-such-session')
    expect(result.success).toBe(true)
  })

  it('search returns a bare array (RAW-THROW), [] on an empty vector store', async () => {
    const result = await grp.search('anything')
    expect(Array.isArray(result)).toBe(true)
    expect(result).toEqual([])
  })

  it('getChunks returns a bare array (RAW-THROW), [] on an empty vector store', async () => {
    const result = await grp.getChunks()
    expect(Array.isArray(result)).toBe(true)
    expect(result).toEqual([])
  })

  it('indexTranscript gracefully no-ops without an embeddings API key', async () => {
    const result = await grp.indexTranscript('some transcript text to index', {})
    expect(typeof result.indexed).toBe('number')
  })

  // FIXED: findActionItems() now unwraps `POST /api/rag/find-action-items`'s
  // `{ actionItems: string }` envelope, so `.data` is the bare string its `Result<string>`
  // return type promises (same class of fix as `cancel()` / `removeLastMessages()` above,
  // and as `summarizeMeeting()`'s `{summary}` unwrap).
  it('findActionItems unwraps {actionItems} — .data is the bare string', async () => {
    // findActionItems() calls getChatProvider() eagerly (before checking whether it even needs
    // to call the provider), and the default 'gemini' provider throws synchronously if no API
    // key is configured — so a fake (non-network-touching) key must be seeded first. Since the
    // vector store is empty, the code path returns before ever calling chatProvider.chat(), so
    // no real network call happens.
    const { saveConfig } = await import('../../../../electron/main/services/config')
    await saveConfig({ transcription: { geminiApiKey: 'fake-test-key-not-real' } } as never)

    const result = await grp.findActionItems()
    expect(result.success).toBe(true)
    if (result.success) {
      expect(typeof result.data).toBe('string')
      expect(result.data).toBe('No meeting transcripts found.')
    }
  })

  // FIXED: rag.globalSearch() now calls the actually-registered `GET /api/rag/global-search`
  // route (not `/api/rag/search`, and without the unregistered `scope` query param), and
  // returns the `{knowledge,people,projects}` shape produced by
  // `ragService.globalSearch()` (electron/server/services/../main/services/rag.ts). Note the
  // route forwards that service's own `Result<T>` envelope verbatim (always HTTP 200) rather
  // than unwrapping it like its sibling routes — so the group unwraps that inner envelope too.
  it('globalSearch hits the real route and returns {knowledge,people,projects}', async () => {
    const result = await grp.globalSearch('anything')
    expect(result.success).toBe(true)
    if (result.success) {
      const data = result.data
      expect(Array.isArray(data.knowledge)).toBe(true)
      expect(Array.isArray(data.people)).toBe(true)
      expect(Array.isArray(data.projects)).toBe(true)
    }
  })
})
