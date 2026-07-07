/**
 * quality.contract.test.ts — Layer-2 SDK↔route contract tests for the quality group.
 * See `contract-harness.ts` for the harness design.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeQualityGroup } from '../groups/quality'
import { http } from '../http'
import { makeContractApp, installFetchShim, closeContractApp, type ContractApp } from './contract-harness'

describe('quality contract', () => {
  let ctx: ContractApp
  const grp = makeQualityGroup({ http })
  const recId = 'rec-quality-1'

  beforeEach(async () => {
    ctx = await makeContractApp()
    installFetchShim(ctx.app, ctx.cookie)

    const { insertRecording } = await import('../../../../electron/main/services/database')
    insertRecording({
      id: recId,
      filename: 'q1.hda',
      file_path: null,
      date_recorded: '2024-01-01T10:00:00Z',
      status: 'ready',
      location: 'device-only',
      transcription_status: 'complete',
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

  it('get returns null before any assessment exists (RAW-THROW, no 404)', async () => {
    const result = await grp.get(recId)
    expect(result).toBeNull()
  })

  it('set persists a manual assessment and returns it', async () => {
    const result = await grp.set(recId, 'high', 'looked good', 'tester')
    expect(result.quality).toBe('high')
    const after = await grp.get(recId)
    expect(after.quality).toBe('high')
  })

  it('autoAssess returns a heuristic assessment object', async () => {
    const result = await grp.autoAssess(recId)
    expect(result.recording_id).toBe(recId)
    expect(['high', 'medium', 'low']).toContain(result.quality)
  })

  it('batchAutoAssess returns {assessed, items}', async () => {
    const result = await grp.batchAutoAssess([recId])
    expect(result.assessed).toBe(1)
    expect(Array.isArray(result.items)).toBe(true)
  })

  it('assessUnassessed returns {assessed}', async () => {
    const result = await grp.assessUnassessed()
    expect(typeof result.assessed).toBe('number')
  })

  // KNOWN CONTRACT BUG (found by this harness): quality.getByQuality() calls
  // `GET /api/recordings?quality=<level>`, but electron/server/routes/recordings.ts's `listQ`
  // zod schema does not declare a `quality` field at all — zod silently strips it, so the
  // route ignores the filter entirely and returns the FULL unfiltered `{items,total}`
  // pagination envelope instead of an array of recordings matching `quality`. The route's own
  // comment confirms this is known/intentional-for-now: "recordings-by-quality is provided by
  // the 0c-4 quality domain (needs the knowledge_captures join); not a recordings column."
  // This test documents the actual (buggy) behavior rather than the SDK's promised contract;
  // see the harness report for the recommended fix.
  it('getByQuality does NOT filter and returns the pagination envelope, not a bare array', async () => {
    await grp.set(recId, 'high')
    const { insertRecording } = await import('../../../../electron/main/services/database')
    insertRecording({
      id: 'rec-quality-2-low',
      filename: 'q2.hda',
      file_path: null,
      date_recorded: '2024-01-02T10:00:00Z',
      status: 'ready',
      location: 'device-only',
      transcription_status: 'complete',
      on_device: 1,
      on_local: 0,
      source: 'hidock',
      is_imported: 0
    })

    const result = await grp.getByQuality('high')
    // What the SDK's return type (Promise<any>, meant to be a recording list) implies callers
    // expect: a bare array containing only the 'high' recording.
    // What actually comes back: the unfiltered {items,total} envelope with BOTH recordings.
    expect(Array.isArray(result)).toBe(false)
    expect(result.items).toHaveLength(2)
    expect(result.total).toBe(2)
  })
})
