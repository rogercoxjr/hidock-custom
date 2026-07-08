/**
 * migration.contract.test.ts — Layer-2 SDK↔route contract tests for the migration group.
 * See `contract-harness.ts` for the harness design (boots the REAL Fastify `buildApp`, logs in
 * an admin, and shims global `fetch` → `app.inject()` so the REAL `makeMigrationGroup({ http })`
 * runs against the REAL routes + handlers in-process).
 *
 * COVERAGE: every method on `makeMigrationGroup` has a safe, no-network happy path, so all are
 * covered here:
 *   - getStatus()      GET  /api/migration/status      — read-only counts
 *   - previewCleanup() GET  /api/migration/preview     — read-only preview arrays
 *   - runCleanup()     POST /api/migration/run-cleanup — mutation; a no-op on clean seed data
 *   - runV11()         POST /api/migration/run-v11     — mutation; empty-migration (no transcript
 *                                                        rows) short-circuits before inserting
 *   - rollbackV11()    POST /api/migration/rollback-v11 — mutation; drops/reverts (idempotent)
 *
 * All five are RAW-THROW methods (per CONTRACTS.md Migration table) that return the route's BARE
 * response body — none is a RESULT ({success,data}) envelope. So each test asserts (a) the call
 * does not throw / the route did not 4xx (no 400/404/405), and (b) the returned value is the bare
 * typed shape the group's signature promises (nested arrays are arrays, not {items,total}; there
 * is NO wrapping {success,data} envelope around the payload).
 *
 * SEEDING: one recording (no transcript) is seeded per test so `getStatus` returns a meaningful
 * non-empty `total`, while `runV11`'s `INNER JOIN transcripts` yields zero rows → the handler
 * short-circuits before touching `knowledge_captures`, keeping this on the exact happy path the
 * server-side `electron/server/__tests__/migration.test.ts` already proves returns HTTP 200.
 *
 * OUT OF SCOPE (documented, not silently dropped):
 *   - migration.onProgress — NOT defined on this group (see migration.ts header): it is a WS
 *     event subscription merged in from the events group, not an HTTP method, so there is no
 *     SDK↔route request/response contract to exercise here.
 *   - No method here needs live network / LLM / multipart / streaming, so nothing is skipped for
 *     those reasons (unlike the rag / calendar groups).
 *
 * All five contracts hold as written — no method is `it.skip`/`it.todo`, because no SDK↔route
 * mismatch was found (each route returns the bare body the RAW-THROW group casts and returns).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeMigrationGroup } from '../groups/migration'
import { http } from '../http'
import { makeContractApp, installFetchShim, closeContractApp, type ContractApp } from './contract-harness'

describe('migration contract', () => {
  let ctx: ContractApp
  const grp = makeMigrationGroup({ http })

  beforeEach(async () => {
    ctx = await makeContractApp()
    installFetchShim(ctx.app, ctx.cookie)

    // Seed a single, valid recording (no transcript) so `getStatus` sees a real row and
    // `previewCleanup`/`runCleanup` have data to evaluate (all clean → nothing to remove).
    const { insertRecording } = await import('../../../../electron/main/services/database')
    insertRecording({
      id: 'rec-mig-1',
      filename: 'mig1.hda',
      file_path: null,
      date_recorded: '2024-01-01T10:00:00Z',
      status: 'ready',
      location: 'device-only',
      transcription_status: 'none',
      on_device: 1,
      on_local: 0,
      source: 'hidock',
      is_imported: 0
    })
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await closeContractApp(ctx)
  })

  it('getStatus returns the bare MigrationStatus (RAW-THROW, not a {success,data} envelope)', async () => {
    const result = await grp.getStatus()
    // Bare body: numeric counts live at the top level, not under `.data`.
    expect((result as unknown as { data?: unknown }).data).toBeUndefined()
    expect(typeof result.pending).toBe('number')
    expect(typeof result.migrated).toBe('number')
    expect(typeof result.skipped).toBe('number')
    expect(typeof result.total).toBe('number')
    // The seeded recording is counted.
    expect(result.total).toBeGreaterThanOrEqual(1)
    expect(result.pending).toBeGreaterThanOrEqual(1)
  })

  it('previewCleanup returns bare arrays (arrays are arrays, not {items,total})', async () => {
    const result = await grp.previewCleanup()
    expect(Array.isArray(result.orphanedTranscripts)).toBe(true)
    expect(Array.isArray(result.duplicateRecordings)).toBe(true)
    expect(Array.isArray(result.invalidMeetingRefs)).toBe(true)
    // Clean seed data → nothing flagged for cleanup.
    expect(result.orphanedTranscripts).toEqual([])
    expect(result.duplicateRecordings).toEqual([])
    expect(result.invalidMeetingRefs).toEqual([])
  })

  it('runCleanup returns the bare CleanupResult and is a no-op on clean data', async () => {
    const result = await grp.runCleanup()
    expect(result.success).toBe(true)
    expect(result.orphanedTranscriptsRemoved).toBe(0)
    expect(result.duplicateRecordingsRemoved).toBe(0)
    expect(result.invalidMeetingRefsFixed).toBe(0)
    expect(Array.isArray(result.errors)).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('runV11 returns the bare MigrationResult (empty-migration happy path)', async () => {
    const result = await grp.runV11()
    expect(result.success).toBe(true)
    // No transcript rows → nothing to migrate; the handler short-circuits before inserting.
    expect(result.capturesCreated).toBe(0)
    expect(Array.isArray(result.errors)).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('rollbackV11 returns the bare MigrationRollbackResult', async () => {
    const result = await grp.rollbackV11()
    expect(result.success).toBe(true)
    expect(Array.isArray(result.errors)).toBe(true)
    expect(result.errors).toEqual([])
  })
})
