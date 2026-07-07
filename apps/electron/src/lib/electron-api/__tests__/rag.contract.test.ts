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

  // KNOWN CONTRACT BUG (found by this harness): rag.cancel()'s return type promises
  // `Result<boolean>` (a bare boolean in `.data`), and the group even writes
  // `data: r.data as boolean` — but that's a type-level lie: `POST /api/rag/cancel` returns
  // `{ cancelled: boolean }`, and the group never unwraps `.cancelled`. `.data` is the raw
  // `{cancelled}` object at runtime, not a boolean.
  it('cancel does NOT unwrap {cancelled} — .data is the envelope object, not a bare boolean', async () => {
    const result = await grp.cancel('no-such-session')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).not.toBe(false)
      expect((result.data as unknown as { cancelled: boolean }).cancelled).toBe(false)
    }
  })

  // KNOWN CONTRACT BUG (found by this harness): same class of bug as `cancel()` above —
  // `removeLastMessages()` promises `Result<number>` but `POST .../trim` returns
  // `{ removed: number }`; the group casts `r.data as number` without unwrapping `.removed`.
  it('removeLastMessages does NOT unwrap {removed} — .data is the envelope object, not a bare number', async () => {
    const result = await grp.removeLastMessages('no-such-session', 3)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).not.toBe(0)
      expect((result.data as unknown as { removed: number }).removed).toBe(0)
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

  // KNOWN CONTRACT BUG (found by this harness): same unwrap bug as `cancel()` /
  // `removeLastMessages()` above — findActionItems()'s type signature promises
  // `Result<string>` (a bare string in `.data`), but `POST /api/rag/find-action-items` returns
  // `{ actionItems: string }`, and the group casts `r.data as string` without unwrapping
  // `.actionItems`. All three (plus, by the same pattern, the untested `summarizeMeeting()`,
  // which returns `{summary}`) share this bug — it looks systemic to rag.ts's RESULT-style
  // methods rather than a one-off typo.
  it('findActionItems does NOT unwrap {actionItems} — .data is the envelope object, not a bare string', async () => {
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
      expect(typeof result.data).not.toBe('string')
      expect((result.data as unknown as { actionItems: string }).actionItems).toBe(
        'No meeting transcripts found.'
      )
    }
  })

  // KNOWN CONTRACT BUG (found by this harness): rag.globalSearch() builds
  // `GET /api/rag/search?q=...&scope=global` — the SAME path as rag.search(), just with an
  // extra `scope` query param the server's zod schema doesn't declare (so it's silently
  // dropped). It never calls the actually-registered `GET /api/rag/global-search` route (see
  // electron/server/routes/rag.ts, which registers both as distinct endpoints backed by
  // different services: `/api/rag/search` → vectorStore.search() → array of
  // {content,meetingId,subject,score}; `/api/rag/global-search` → ragService.globalSearch() →
  // {knowledge,people,projects}). The SDK's return type promises
  // `Result<{knowledge,people,projects}>`, but the actual response is the `/api/rag/search`
  // array shape. This is a straight copy-paste bug in groups/rag.ts's globalSearch().
  it('globalSearch hits the wrong route and returns the search() array shape, not {knowledge,…}', async () => {
    const result = await grp.globalSearch('anything')
    expect(result.success).toBe(true)
    if (result.success) {
      const data = result.data as unknown
      // What the SDK's type signature promises:
      expect(data).not.toHaveProperty('knowledge')
      // What actually comes back (the array `/api/rag/search` produces):
      expect(Array.isArray(data)).toBe(true)
    }
  })
})
