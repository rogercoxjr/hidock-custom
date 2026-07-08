/**
 * integrity.contract.test.ts — Layer-2 SDK↔route contract tests for the integrity group.
 * See `contract-harness.ts` for the harness design.
 *
 * COVERAGE: every method of `makeIntegrityGroup` has a safe, no-network happy path and is
 * exercised here — the integrity namespace is entirely local (SQLite + local fs); nothing in
 * `integrity-service.ts` reaches an external HTTP/LLM/embedding dependency (verified: no
 * `fetch`/provider imports in that service). All seven methods map 1:1 onto a registered
 * Fastify route, so each test asserts (a) the SDK call does NOT throw / the route answers 2xx
 * (no 400/404/405) and (b) the returned value is the unwrapped/typed shape the group's own
 * signature promises: RAW-THROW methods return the bare object (never a `{success,data}`
 * envelope, and `issuesByType`/`issuesBySeverity` are maps not arrays); INLINE methods return
 * the bare `{issueId,success,action,error?}` record; INLINE-array `repairAll` returns a real
 * array (not `{items,total}`). None of integrity's methods are RESULT groups, so no
 * `{success:true,data}` assertions apply.
 *
 * NOTHING SKIPPED for network/LLM/multipart/streaming reasons — integrity has no such method.
 * Two behavioural notes (NOT skips):
 *   - `runScan` broadcasts `integrity:progress` over /ws, but that is an in-process websocket
 *     fan-out that no-ops with zero connected clients — it is not an outbound `fetch`, so the
 *     process-wide fetch shim never intercepts it.
 *   - `repairIssue`/`repairAll` are exercised on their "no prior scan report" business path
 *     (repairIssue → a 200 inline `success:false` record; repairAll → `[]`). That is still a
 *     valid *contract* happy path: the route answers 200 with the correctly-typed shape. Their
 *     actual repair logic is unit-tested against the service directly elsewhere and is out of
 *     scope for a route-contract check.
 *
 * If any assertion here fails because the SDK↔route contract is genuinely broken (wrong path,
 * missing unwrap, wrapped array, etc.) that is a REAL product bug — it must be converted to a
 * documented `it.skip`/`it.todo` naming the mismatch and reported, NOT fixed by weakening the
 * assertion. As of writing, all seven contracts verify clean.
 */

import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeIntegrityGroup } from '../groups/integrity'
import { http } from '../http'
import { makeContractApp, installFetchShim, closeContractApp, type ContractApp } from './contract-harness'

describe('integrity contract', () => {
  let ctx: ContractApp
  const grp = makeIntegrityGroup({ http })

  beforeEach(async () => {
    ctx = await makeContractApp()
    installFetchShim(ctx.app, ctx.cookie)

    // Seed two recordings: one whose file exists on disk (kept by purge) and one "ghost"
    // whose file is absent (deleted by purge). Mirrors electron/server/__tests__/integrity.test.ts
    // so the purge/scan happy paths operate on real fixture rows, and `deletedFiles` comes back
    // as a populated string[] (best asserts the arrays-are-arrays invariant).
    const { insertRecording } = await import('../../../../electron/main/services/database')
    const recsDir = join(ctx.dir, 'recordings')
    mkdirSync(recsDir, { recursive: true })
    const realPath = join(recsDir, '2024-01-01_1000.wav')
    writeFileSync(realPath, Buffer.alloc(2048))

    insertRecording({
      id: 'int-rec-1',
      filename: '2024-01-01_1000.wav',
      file_path: realPath,
      date_recorded: '2024-01-01T10:00:00Z',
      status: 'ready',
      location: 'local-only',
      transcription_status: 'none',
      on_device: 0,
      on_local: 1,
      source: 'hidock',
      is_imported: 0
    })
    insertRecording({
      id: 'int-rec-missing',
      filename: 'ghost.wav',
      file_path: join(recsDir, 'ghost.wav'),
      date_recorded: '2024-01-02T10:00:00Z',
      status: 'ready',
      location: 'local-only',
      transcription_status: 'none',
      on_device: 0,
      on_local: 1,
      source: 'hidock',
      is_imported: 0
    })
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await closeContractApp(ctx)
  })

  it('getReport returns null before any scan (RAW-THROW, unwrapped)', async () => {
    const result = await grp.getReport()
    expect(result).toBeNull()
  })

  it('runScan returns the bare IntegrityReport — maps are maps, issues is an array', async () => {
    const result = await grp.runScan()
    // Bare report object, NOT a {success,data} envelope.
    expect(result).not.toHaveProperty('success')
    expect(typeof result.scanStarted).toBe('string')
    expect(typeof result.scanCompleted).toBe('string')
    expect(typeof result.totalIssues).toBe('number')
    expect(typeof result.autoRepairableCount).toBe('number')
    // issues is a plain array (not {items,total}); issuesByType/BySeverity are maps not arrays.
    expect(Array.isArray(result.issues)).toBe(true)
    expect(Array.isArray(result.issuesByType)).toBe(false)
    expect(Array.isArray(result.issuesBySeverity)).toBe(false)
    expect(typeof result.issuesByType).toBe('object')
    expect(typeof result.issuesBySeverity).toBe('object')
  })

  it('getReport returns the stored report after a scan (runScan↔getReport consistency)', async () => {
    const scan = await grp.runScan()
    const report = await grp.getReport()
    expect(report).not.toBeNull()
    expect(report.scanStarted).toBe(scan.scanStarted)
    expect(Array.isArray(report.issues)).toBe(true)
  })

  it('repairIssue returns the bare inline {issueId,success,action} record (INLINE)', async () => {
    const result = await grp.repairIssue('nonexistent-issue-id')
    // The route answers 200 with the service's inline RepairResult even on the no-report path,
    // so the SDK does not throw and returns that bare record verbatim.
    expect(result.issueId).toBe('nonexistent-issue-id')
    expect(typeof result.success).toBe('boolean')
    expect(typeof result.action).toBe('string')
  })

  it('repairAll returns a bare array (INLINE-array), [] before any scan', async () => {
    const result = await grp.repairAll()
    expect(Array.isArray(result)).toBe(true)
    expect(result).toEqual([])
  })

  it('runStartupChecks returns bare {issuesFound,issuesFixed} numbers (RAW-THROW)', async () => {
    const result = await grp.runStartupChecks()
    expect(result).not.toHaveProperty('success')
    expect(typeof result.issuesFound).toBe('number')
    expect(typeof result.issuesFixed).toBe('number')
  })

  it('cleanupWronglyNamed returns bare {deletedFiles,keptFiles,clearedDbRecords} (RAW-THROW)', async () => {
    const result = await grp.cleanupWronglyNamed()
    expect(result).not.toHaveProperty('success')
    expect(Array.isArray(result.deletedFiles)).toBe(true)
    expect(Array.isArray(result.keptFiles)).toBe(true)
    expect(typeof result.clearedDbRecords).toBe('number')
  })

  it('purgeMissingFiles returns bare {totalRecords,deleted,kept,deletedFiles} (RAW-THROW)', async () => {
    const result = await grp.purgeMissingFiles()
    expect(result).not.toHaveProperty('success')
    expect(typeof result.totalRecords).toBe('number')
    expect(typeof result.deleted).toBe('number')
    expect(typeof result.kept).toBe('number')
    expect(Array.isArray(result.deletedFiles)).toBe(true)
    // The ghost row is purged; the row with a real file on disk is kept.
    expect(result.deleted).toBeGreaterThanOrEqual(1)
    expect(result.kept).toBeGreaterThanOrEqual(1)
    expect(result.deletedFiles).toContain('ghost.wav')
  })
})
