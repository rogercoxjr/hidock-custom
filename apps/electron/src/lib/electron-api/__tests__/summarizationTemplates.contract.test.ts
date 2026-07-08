/**
 * summarizationTemplates.contract.test.ts — Layer-2 SDK↔route contract tests for the
 * summarizationTemplates group. See `contract-harness.ts` for the harness design.
 *
 * Runs the REAL `makeSummarizationTemplatesGroup({ http })` (real `http.ts` transport) against
 * the REAL Fastify app via the in-process `app.inject()` fetch shim. Each test seeds only the
 * minimal DB state the method needs (mirroring the sibling contract tests), then asserts the SDK
 * call (a) succeeds — no 400/404/405 — and (b) returns the unwrapped/typed shape its own return
 * type promises: RESULT-group methods return `{ success: true, data }` with `data` being the bare
 * payload (arrays are arrays, not `{ items, total }`; RESULT<true> yields `data === true`).
 *
 * COVERED (safe happy paths — no network/LLM, no side-effects):
 *   - list            GET  /api/summarization-templates            (empty-ish: always ≥1 builtin)
 *   - create          POST /api/summarization-templates            (simple create, HTTP 201)
 *   - update          PATCH .../:id                                 (seeded user template)
 *   - setEnabled      PATCH .../:id  ({enabled})                    (seeded user template)
 *   - delete          DELETE .../:id                                (seeded user template)
 *   - latestRun       GET  /api/recordings/:id/template-run         (null-shape, no run seeded)
 *
 * DELIBERATELY SKIPPED (need live LLM / trigger background re-summarization side-effects — the
 * process-wide `fetch` stub can't safely stand in for a real chat/LLM provider, mirroring the
 * chat/summarizeMeeting skips in rag.contract.test.ts):
 *   - previewSelection        GET  /api/recordings/:id/template-selection — requires transcript
 *       full_text (else 404) and then calls `selectTemplateForTranscript(..., llm)`, i.e. a live
 *       LLM round trip. No happy path exists without a real provider.
 *   - acceptSuggestedTemplate POST /api/recordings/:id/accept-suggested-template — requires a
 *       seeded selector run carrying `suggestedTemplateJson` AND fires a fire-and-forget
 *       `processQueueManually()` re-summarize (LLM) as a side-effect. Not a safe sandboxed path.
 *   - resummarizeWithTemplate POST /api/recordings/:id/resummarize — the INLINE-envelope method;
 *       its whole purpose is to enqueue + fire-and-forget `processQueueManually()` (LLM). Skipped
 *       for the same background-side-effect reason.
 *
 * No genuine SDK↔route contract mismatch was found in the covered methods, so every test below is
 * a live (non-skipped) assertion. Had one caught a real defect, it would be `it.skip`/`it.todo`
 * with a TODO naming the mismatch rather than weakened to pass.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeSummarizationTemplatesGroup } from '../groups/summarizationTemplates'
import { http } from '../http'
import { makeContractApp, installFetchShim, closeContractApp, type ContractApp } from './contract-harness'

describe('summarizationTemplates contract', () => {
  let ctx: ContractApp
  let seededTemplateId: string
  const grp = makeSummarizationTemplatesGroup({ http })

  beforeEach(async () => {
    ctx = await makeContractApp()
    installFetchShim(ctx.app, ctx.cookie)

    // Seed one non-builtin user template so update/setEnabled/delete have a mutable target.
    // Import AFTER makeContractApp() (which calls vi.resetModules()) so the service binds to the
    // fresh per-test DB, mirroring how transcripts.contract.test.ts imports database helpers.
    const { createTemplate } = await import('../../../../electron/main/services/summarization-templates')
    seededTemplateId = createTemplate({
      name: 'Seeded Standup',
      description: 'seed description',
      instructions: 'Summarize the standup with owners and action items.',
      exampleTriggers: ['standup', 'daily']
    }).id
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await closeContractApp(ctx)
  })

  it('list returns a RESULT envelope wrapping a bare array (not {items,total})', async () => {
    const result = await grp.list()
    expect(result.success).toBe(true)
    if (result.success) {
      expect(Array.isArray(result.data)).toBe(true)
      // Fresh DBs seed the built-in "Default" template, so the list is never empty.
      expect(result.data.length).toBeGreaterThanOrEqual(1)
      const builtin = result.data.find((t) => t.id === 'builtin-default')
      expect(builtin).toBeDefined()
      expect(builtin?.isBuiltin).toBe(true)
    }
  })

  it('create returns a RESULT envelope wrapping the created template (HTTP 201, no throw)', async () => {
    const result = await grp.create({
      name: 'Contract Created Template',
      description: 'made by the contract test',
      instructions: 'Summarize crisply with owners and due dates.',
      exampleTriggers: ['kickoff']
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(typeof result.data.id).toBe('string')
      expect(result.data.name).toBe('Contract Created Template')
      expect(result.data.isBuiltin).toBe(false)
      expect(Array.isArray(result.data.exampleTriggers)).toBe(true)
    }
  })

  it('update returns a RESULT envelope wrapping the updated template', async () => {
    const result = await grp.update(seededTemplateId, { description: 'updated by contract test' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.id).toBe(seededTemplateId)
      expect(result.data.description).toBe('updated by contract test')
    }
  })

  it('setEnabled returns RESULT<true> — data is the bare boolean true', async () => {
    const result = await grp.setEnabled(seededTemplateId, false)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toBe(true)
    }
  })

  it('delete returns RESULT<true> — data is the bare boolean true', async () => {
    const result = await grp.delete(seededTemplateId)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toBe(true)
    }
  })

  it('latestRun returns a RESULT envelope wrapping LatestRunView (null-shape when no run exists)', async () => {
    // A recording with neither a transcript nor a selector run is a valid empty happy path: the
    // route returns the all-null LatestRunView shape (HTTP 200, no 404), which the SDK wraps.
    const result = await grp.latestRun('rec-with-no-run')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.name).toBeNull()
      expect(result.data.confidence).toBeNull()
      expect(result.data.kind).toBeNull()
      expect(result.data.suggestedTemplate).toBeNull()
      expect(result.data.instructionsChanged).toBe(false)
    }
  })
})
