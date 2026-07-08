/**
 * outputs.contract.test.ts — Layer-2 SDK↔route contract tests for the outputs group.
 * See `contract-harness.ts` for the harness design.
 *
 * Runs the REAL `makeOutputsGroup({ http })` (real `http.ts` transport) against the REAL
 * Fastify app, seeding minimal DB state via the same `main/services/database` helpers the
 * server uses, then asserting each SDK call succeeds and returns the unwrapped/typed shape its
 * own signature promises (all three live methods are RESULT-shaped → `{ success: true, data }`).
 *
 * COVERED (safe happy paths, no live network):
 *   - getTemplates()       → GET /api/outputs/templates. Read-only, pure in-process template
 *                            catalogue (no DB, no network). RESULT<OutputTemplate[]>: `data` is a
 *                            bare array (not `{items,total}`) of the four built-in templates.
 *   - getByActionableId()  → GET /api/actionables/:id/output. Two happy paths: an actionable
 *                            WITH a persisted output row (RESULT<GenerateOutputResponse>) and one
 *                            WITHOUT (route returns bare `null` at HTTP 200 → RESULT<null>, still
 *                            success — a 404 means the actionable itself is absent, not "no output
 *                            yet"). Seeds knowledge_captures + actionables (+ outputs) exactly as
 *                            electron/server/__tests__/outputs.test.ts does.
 *
 * SKIPPED — live LLM (documented here, no placeholder test, mirroring rag.contract.test.ts):
 *   - generate()  → POST /api/outputs/generate drives `output-generator` which collects
 *                   transcripts and calls `getChatProvider().chat()` (a real Gemini/OpenAI/Ollama
 *                   round trip). The harness's process-wide `fetch` stub would silently redirect
 *                   any provider network call back into `app.inject()`, producing a meaningless
 *                   result rather than a real LLM response — so it is out of scope for a
 *                   sandboxed, no-network contract run.
 *
 * SKIPPED — DROPPED / browser-native, no Fastify route backs them (per CONTRACTS.md §Outputs):
 *   - copyToClipboard() → navigator.clipboard.writeText (Task 10). The SDK method returns a
 *                         failure Result immediately WITHOUT calling `http`, so there is no
 *                         SDK↔route contract to exercise.
 *   - saveToFile()      → browser download (anchor + Blob, Task 10). Same as above — returns a
 *                         failure Result without hitting a route. (The unrelated
 *                         POST /api/outputs/download route exists but this SDK method never calls
 *                         it, so it is not part of the outputs group's contract surface.)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeOutputsGroup } from '../groups/outputs'
import { http } from '../http'
import { makeContractApp, installFetchShim, closeContractApp, type ContractApp } from './contract-harness'

describe('outputs contract', () => {
  let ctx: ContractApp
  const grp = makeOutputsGroup({ http })
  const kcId = 'kc-outputs-1'

  beforeEach(async () => {
    ctx = await makeContractApp()
    installFetchShim(ctx.app, ctx.cookie)

    // knowledge_captures is the FK parent for both actionables.source_knowledge_id and
    // outputs.knowledge_capture_id — seed it once so per-test rows can reference it.
    const { run } = await import('../../../../electron/main/services/database')
    run(`INSERT INTO knowledge_captures (id, title, captured_at) VALUES (?, ?, ?)`, [
      kcId,
      'Outputs source capture',
      '2024-01-03T10:00:00Z'
    ])
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await closeContractApp(ctx)
  })

  it('getTemplates returns a RESULT wrapping a bare OutputTemplate[] (not {items,total})', async () => {
    const result = await grp.getTemplates()
    expect(result.success).toBe(true)
    if (result.success) {
      expect(Array.isArray(result.data)).toBe(true)
      expect(result.data.length).toBeGreaterThan(0)
      const ids = result.data.map((t) => t.id)
      expect(ids).toContain('meeting_minutes')
      expect(ids).toContain('interview_feedback')
      expect(ids).toContain('project_status')
      expect(ids).toContain('action_items')
      const t = result.data[0]
      expect(typeof t.id).toBe('string')
      expect(typeof t.name).toBe('string')
      expect(typeof t.description).toBe('string')
    }
  })

  it('getByActionableId returns a RESULT wrapping the bare output object when one exists', async () => {
    const { run } = await import('../../../../electron/main/services/database')
    run(
      `INSERT INTO outputs (id, knowledge_capture_id, template_id, template_name, content, generated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['out-1', kcId, 'meeting_minutes', 'meeting_minutes', '# Minutes\nSome content', '2024-01-03T12:00:00Z']
    )
    run(
      `INSERT INTO actionables (id, type, title, source_knowledge_id, status, artifact_id, generated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['act-with-output', 'report', 'Done report', kcId, 'generated', 'out-1', '2024-01-03T12:00:00Z']
    )

    const result = await grp.getByActionableId('act-with-output')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).not.toBeNull()
      expect(result.data?.content).toBe('# Minutes\nSome content')
      expect(result.data?.templateId).toBe('meeting_minutes')
      expect(typeof result.data?.generatedAt).toBe('string')
    }
  })

  it('getByActionableId succeeds with data:null when the actionable has no output yet', async () => {
    const { run } = await import('../../../../electron/main/services/database')
    run(`INSERT INTO actionables (id, type, title, source_knowledge_id, status) VALUES (?, ?, ?, ?, ?)`, [
      'act-no-output',
      'report',
      'Draft report',
      kcId,
      'pending'
    ])

    // Bare `null` at HTTP 200 is the "no output generated yet" contract — still a success, NOT a
    // 404 (a 404 would mean the actionable row itself is missing).
    const result = await grp.getByActionableId('act-no-output')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toBeNull()
    }
  })
})
