/**
 * summarization.contract.test.ts — Layer-2 SDK↔route contract tests for the summarization group.
 * See `contract-harness.ts` for the harness design.
 *
 * THE SUMMARIZATION GROUP IS 100% LIVE-NETWORK. Its only two methods —
 *   - listModels()   → GET  /api/summarization/models          (server proxies api.ollama.com/api/tags)
 *   - testConnection → POST /api/summarization/test-connection (server proxies api.ollama.com/api/chat)
 * are admin-only endpoints whose Fastify handlers UNCONDITIONALLY `fetch()` Ollama Cloud
 * (electron/server/routes/summarization.ts). Neither route short-circuits on a missing/empty
 * API key (unlike rag's embeddings path) — they issue the outbound `fetch` with an empty
 * `Authorization: Bearer` header regardless. So there is NO sandbox-runnable *happy path*
 * (success:true) for either method here: the harness's `installFetchShim` stubs `fetch`
 * PROCESS-WIDE, so the server's own outbound `fetch(https://api.ollama.com/…)` is silently
 * redirected into `app.inject()` too, hitting the unregistered path `/api/tags` (or `/api/chat`)
 * → 404 → the route re-raises it as a `BadRequestError` (HTTP 400). This is exactly the
 * live-external-dependency exclusion the harness header documents; the real success path is
 * covered at the server layer by `electron/server/__tests__/summarization.test.ts`, which mocks
 * `global.fetch` per-test to return controlled Ollama responses.
 *
 * WHAT THIS FILE STILL LOCKS DOWN (network-independent, so robust even if the sandbox ever
 * gains real egress): the SDK↔route WIRING + INLINE-envelope contract up to the Ollama boundary.
 * Both methods are reachable at the right path/method, pass requireAuth+requireAdmin (bootstrap
 * admin) and — for test-connection — requireSameOrigin (inject sends no Origin, which the guard
 * intentionally allows), then the SDK maps whatever the route returns onto its documented INLINE
 * shape `{ success, models?, error?, details? }` WITHOUT throwing. Per the group's own header
 * these are INLINE (NOT generic Result<T>) — so `success` is a boolean and the value never
 * carries a `data` field. That RESULT-vs-INLINE distinction is a real regression target and is
 * asserted below. The success:true branch (models array / connection ok) is `it.skip` with the
 * network reason so the gap stays tracked.
 *
 * NO REAL SDK↔route BUG was found for this group (paths/methods/body schemas all line up).
 * One minor, non-failing drift is tracked as an `it.todo` below: the SDK still appends a
 * `?apiKey=` query param that the route intentionally dropped for security and now ignores.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeSummarizationGroup } from '../groups/summarization'
import { http } from '../http'
import { makeContractApp, installFetchShim, closeContractApp, type ContractApp } from './contract-harness'

describe('summarization contract', () => {
  let ctx: ContractApp
  const grp = makeSummarizationGroup({ http })

  beforeEach(async () => {
    ctx = await makeContractApp()
    installFetchShim(ctx.app, ctx.cookie)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await closeContractApp(ctx)
  })

  // ---------------------------------------------------------------------------
  // listModels — GET /api/summarization/models
  // ---------------------------------------------------------------------------

  it('listModels reaches the route and returns the INLINE {success,...} envelope without throwing', async () => {
    // No real network: the server's fetch(api.ollama.com/api/tags) is redirected by the
    // process-wide shim to the unregistered /api/tags → 404 → route raises BadRequestError (400),
    // so `success` is false here. We assert the SDK↔route WIRING + INLINE contract, which holds
    // regardless of the upstream outcome (see file header).
    const result = await grp.listModels()

    expect(typeof result.success).toBe('boolean')
    // INLINE, not Result<T>: the value must NOT carry a `data` field on either branch.
    expect('data' in result).toBe(false)
    if (!result.success) {
      // On the failure branch the SDK maps the route's 4xx onto a string `error`.
      expect(typeof result.error).toBe('string')
      expect((result.error ?? '').length).toBeGreaterThan(0)
    } else {
      // Should never run in-harness (no network), but pins the typed shape if it ever does.
      expect(Array.isArray(result.models)).toBe(true)
    }
  })

  // SKIP: true happy path needs a live api.ollama.com round trip (valid Ollama Cloud key +
  // reachable network). The harness's process-wide `fetch` stub redirects the server's own
  // outbound fetch into app.inject() (→ meaningless 404), so success:true is unreachable here.
  // Success-path coverage lives in electron/server/__tests__/summarization.test.ts (mocks fetch).
  it.skip('listModels returns {success:true, models: string[]} with a live Ollama Cloud connection', () => {
    // Would assert: result.success === true && Array.isArray(result.models).
  })

  // ---------------------------------------------------------------------------
  // testConnection — POST /api/summarization/test-connection
  // ---------------------------------------------------------------------------

  it('testConnection reaches the route and returns the INLINE {success,...} envelope without throwing', async () => {
    // Same as above: server's fetch(api.ollama.com/api/chat) → shim → unregistered /api/chat →
    // 404, which the route classifies as "model not found" → BadRequestError (400). We assert the
    // SDK↔route wiring + INLINE contract (requireAuth+requireAdmin+requireSameOrigin all pass).
    const result = await grp.testConnection()

    expect(typeof result.success).toBe('boolean')
    // INLINE, not Result<T>: no `data` field on either branch.
    expect('data' in result).toBe(false)
    if (!result.success) {
      expect(typeof result.error).toBe('string')
      expect((result.error ?? '').length).toBeGreaterThan(0)
    }
  })

  // SKIP: true happy path needs a live api.ollama.com round trip (valid key + model + network).
  // Same process-wide-fetch-stub limitation as listModels; success-path coverage lives in
  // electron/server/__tests__/summarization.test.ts.
  it.skip('testConnection returns {success:true} against a live Ollama Cloud connection', () => {
    // Would assert: result.success === true.
  })

  // ---------------------------------------------------------------------------
  // Tracked drift (NOT a failing contract break — no 4xx, so not marked a "real bug"):
  // the SDK's listModels(apiKey) still appends `?apiKey=<key>` to the GET, but the route
  // intentionally dropped that query param for security (it would leak the key into access/proxy
  // logs) and now ignores it — always using the SAVED config key. `listModelsQuery = z.object({})`
  // is non-strict, so the extra key is silently stripped (no 400), which is why this is a latent
  // behavioral mismatch rather than a hard failure: a caller passing an unsaved key to listModels
  // expects it to be validated, but it is not. The route comment directs such callers to
  // testConnection({apiKey}) instead. Tracked here; product code not touched.
  // ---------------------------------------------------------------------------
  it.todo('listModels(apiKey) — server ignores the ?apiKey= query (dropped for security); SDK param is dead')
})
