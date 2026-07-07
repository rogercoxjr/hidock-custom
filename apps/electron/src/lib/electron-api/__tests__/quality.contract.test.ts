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

  // Fixed contract bug: quality.getByQuality() calls `GET /api/recordings?quality=<level>`.
  // electron/server/routes/recordings.ts's `listQ` zod schema now declares a `quality` field
  // and, when present, sources rows from `getRecordingsByQuality()` (the existing
  // recordings⋈quality_assessments join in database.ts) instead of the unfiltered
  // `getRecordings()`. The SDK group now also unwraps `.items` from the route's
  // `{items,total}` pagination envelope, so callers get the bare, filtered array their
  // `Promise<any>` (recording-list) return type implies.
  it('getByQuality filters by quality and returns a bare array', async () => {
    await grp.set(recId, 'high')
    const { insertRecording } = await import('../../../../electron/main/services/database')
    const lowId = 'rec-quality-2-low'
    insertRecording({
      id: lowId,
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
    await grp.set(lowId, 'low')

    const result = await grp.getByQuality('high')
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe(recId)
  })
})
