/**
 * diarization.contract.test.ts — Layer-2 SDK↔route contract tests for the diarization group.
 *
 * Runs the REAL `makeDiarizationGroup({ http })` (real `http.ts` transport) against the REAL
 * Fastify app (see `contract-harness.ts`). Each test seeds minimal DB state via the same
 * `main/services/database` functions the server uses, then asserts the SDK call succeeds and
 * returns the unwrapped/typed shape the group's own type signature promises.
 *
 * COVERAGE: the group exposes exactly two methods, both safe read-only GETs, both covered here:
 *   - getLatestRun(recordingId)       → GET /api/recordings/:id/diarization         → RESULT<DiarizationRun|null>
 *   - getRunsForRecording(recordingId)→ GET /api/recordings/:id/diarization?all=1   → RESULT<DiarizationRun[]>
 * Both are RESULT groups, so the contract is `{ success: true, data }` where `data` is the bare
 * run object / `null` (getLatestRun) or a bare array — NOT an `{items,total}` envelope
 * (getRunsForRecording). Both invariants are asserted below.
 *
 * SEEDING NOTE (why the "empty" happy-path still seeds a row): the route calls
 * `getRecordingById(id)` first and throws NotFoundError (HTTP 404) for an unknown recording, so
 * a truly empty DB is NOT a happy path here — it is a 404. The empty happy-path is therefore an
 * EXISTING recording that simply has zero diarization runs: getLatestRun → data:null,
 * getRunsForRecording → data:[]. Each test seeds via `insertRecording` / `insertDiarizationRun`
 * (mirrors electron/server/__tests__/diarization.test.ts).
 *
 * NOTHING SKIPPED: neither method touches the network / an LLM / multipart / streaming, so none
 * of the harness's out-of-scope categories (see contract-harness.ts header) apply here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeDiarizationGroup } from '../groups/diarization'
import { http } from '../http'
import { makeContractApp, installFetchShim, closeContractApp, type ContractApp } from './contract-harness'

describe('diarization contract', () => {
  let ctx: ContractApp
  const grp = makeDiarizationGroup({ http })

  beforeEach(async () => {
    ctx = await makeContractApp()
    installFetchShim(ctx.app, ctx.cookie)

    const { insertRecording, insertDiarizationRun } = await import('../../../../electron/main/services/database')

    // rec-diar-1: has two diarization runs (older first, newer second) — happy path with data.
    insertRecording({
      id: 'rec-diar-1',
      filename: 'diar1.hda',
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
    insertDiarizationRun({
      id: 'run-old',
      recording_id: 'rec-diar-1',
      provider: 'google',
      model: 'chirp3',
      options_min: 1,
      options_max: 5,
      label_count: 2,
      is_solo: 0,
      created_at: '2024-01-01T11:00:00Z'
    })
    insertDiarizationRun({
      id: 'run-new',
      recording_id: 'rec-diar-1',
      provider: 'google',
      model: 'chirp3',
      options_min: 2,
      options_max: 6,
      label_count: 3,
      is_solo: 0,
      created_at: '2024-01-01T12:00:00Z'
    })

    // rec-diar-empty: exists but has NO diarization runs — empty happy path (null / []).
    insertRecording({
      id: 'rec-diar-empty',
      filename: 'diar-empty.hda',
      file_path: null,
      date_recorded: '2024-02-01T10:00:00Z',
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

  it('getLatestRun returns a RESULT envelope wrapping the newest DiarizationRun', async () => {
    const result = await grp.getLatestRun('rec-diar-1')
    expect(result.success).toBe(true)
    if (result.success) {
      // Unwrapped/typed shape: `.data` is the bare run object, not an envelope.
      expect(result.data).not.toBeNull()
      expect(result.data?.id).toBe('run-new')
      expect(result.data?.recording_id).toBe('rec-diar-1')
      expect(result.data?.label_count).toBe(3)
    }
  })

  it('getLatestRun returns {success:true, data:null} for a recording with no runs', async () => {
    const result = await grp.getLatestRun('rec-diar-empty')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toBeNull()
    }
  })

  it('getRunsForRecording returns a RESULT envelope wrapping a bare array (not {items,total}), newest first', async () => {
    const result = await grp.getRunsForRecording('rec-diar-1')
    expect(result.success).toBe(true)
    if (result.success) {
      // Array is an array, not an `{items,total}` envelope.
      expect(Array.isArray(result.data)).toBe(true)
      expect(result.data).toHaveLength(2)
      expect(result.data[0].id).toBe('run-new')
      expect(result.data[1].id).toBe('run-old')
    }
  })

  it('getRunsForRecording returns {success:true, data:[]} for a recording with no runs', async () => {
    const result = await grp.getRunsForRecording('rec-diar-empty')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(Array.isArray(result.data)).toBe(true)
      expect(result.data).toEqual([])
    }
  })
})
