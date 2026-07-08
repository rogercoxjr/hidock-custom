/**
 * storage.contract.test.ts — Layer-2 SDK↔route contract tests for the storage group.
 * See `contract-harness.ts` for the harness design (boots the REAL buildApp() Fastify app,
 * logs in, and shims global `fetch` to app.inject() so the REAL `makeStorageGroup({ http })`
 * runs against the REAL `GET /api/storage/info` route + `getStorageInfo()` service).
 *
 * COVERED — every method in the storage group has a safe happy path, so all are asserted:
 *   - getInfo() — the ONLY route-backed method: `GET /api/storage/info` (RAW-THROW). Asserted
 *     to (a) not throw / succeed and (b) return the BARE, unwrapped StorageInfo object (the
 *     route returns `getStorageInfo()` verbatim — no `{success,data}` / `{items,total}`
 *     envelope — so `.data` IS the typed shape). Empty-DB is a valid happy path here:
 *     `recordingsCount`/`totalSizeBytes` are simply 0, so NO fixture seeding is required.
 *   - openFolder / openFile / revealInFolder / readRecording / deleteRecording / saveRecording
 *     — DROPPED per storage.ts (0c §4: "no server-side desktop"). These do NOT hit any HTTP
 *     route; the SDK resolves the documented safe default per its type signature. They are
 *     still covered as happy paths: each is asserted to never throw and to resolve exactly the
 *     safe-default shape the group promises (booleans stay booleans, `{success,error}` stays a
 *     record, `saveRecording` returns the sentinel empty string). The fetch shim is installed
 *     but these paths never touch it, which is itself part of the contract being locked in.
 *
 * SKIPPED — none. The storage group has NO methods requiring a live network/LLM round trip, a
 * multipart (postForm) body, or a streaming (postStream) body, so none of the categories the
 * harness header calls out as out-of-scope apply here.
 *
 * No SDK↔route contract defects were found in this group: `getInfo` is a plain unwrapped GET
 * against a bare-object route, and the DROPPED methods never reach the wire.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeStorageGroup } from '../groups/storage'
import { http } from '../http'
import { makeContractApp, installFetchShim, closeContractApp, type ContractApp } from './contract-harness'

describe('storage contract', () => {
  let ctx: ContractApp
  const grp = makeStorageGroup({ http })

  beforeEach(async () => {
    ctx = await makeContractApp()
    installFetchShim(ctx.app, ctx.cookie)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await closeContractApp(ctx)
  })

  it('getInfo returns the bare, unwrapped StorageInfo object (RAW-THROW, empty DB)', async () => {
    const result = await grp.getInfo()

    // (b) unwrapped/typed shape: NOT a {success,data} or {items,total} envelope — the fields
    // live directly on the returned object.
    expect(result).not.toHaveProperty('success')
    expect(result).not.toHaveProperty('items')
    expect(result).not.toHaveProperty('data')

    // StorageInfo string paths (electron/main/services/file-storage.ts:58 StorageInfo).
    expect(typeof result.dataPath).toBe('string')
    expect(typeof result.recordingsPath).toBe('string')
    expect(typeof result.transcriptsPath).toBe('string')
    expect(typeof result.cachePath).toBe('string')
    expect(typeof result.databasePath).toBe('string')

    // StorageInfo numeric fields — 0 on a fresh empty DB is a valid happy path.
    expect(typeof result.totalSizeBytes).toBe('number')
    expect(typeof result.recordingsCount).toBe('number')
    expect(result.recordingsCount).toBe(0)

    // Paths are rooted under the harness's temp data dir (proves it hit the real service).
    expect(result.dataPath).toContain(ctx.dir)
  })

  // ---------------------------------------------------------------------------
  // DROPPED (0c §4): no server-side desktop → client-side no-ops. No route is
  // hit; each must never throw and must resolve its documented safe default.
  // ---------------------------------------------------------------------------

  it('openFolder resolves the safe default `false` without throwing', async () => {
    await expect(grp.openFolder('recordings')).resolves.toBe(false)
  })

  it('openFile resolves the safe {success:false,error} default without throwing', async () => {
    const result = await grp.openFile('/some/path.hda')
    expect(result.success).toBe(false)
    expect(typeof result.error).toBe('string')
  })

  it('revealInFolder resolves the safe {success:false,error} default without throwing', async () => {
    const result = await grp.revealInFolder('/some/path.hda')
    expect(result.success).toBe(false)
    expect(typeof result.error).toBe('string')
  })

  it('readRecording resolves the safe {success:false,error} default without throwing', async () => {
    const result = await grp.readRecording('/some/path.hda')
    expect(result.success).toBe(false)
    expect(typeof result.error).toBe('string')
  })

  it('deleteRecording resolves the safe default `false` without throwing', async () => {
    await expect(grp.deleteRecording('/some/path.hda')).resolves.toBe(false)
  })

  it('saveRecording resolves the sentinel empty string without throwing', async () => {
    await expect(grp.saveRecording('clip.wav', [1, 2, 3], '2024-01-01T10:00:00Z')).resolves.toBe('')
  })
})
