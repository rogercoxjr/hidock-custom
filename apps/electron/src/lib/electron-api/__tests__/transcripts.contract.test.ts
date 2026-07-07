/**
 * transcripts.contract.test.ts — Layer-2 SDK↔route contract tests for the transcripts group.
 *
 * Runs the REAL `makeTranscriptsGroup({ http })` (real `http.ts` transport) against the REAL
 * Fastify app (see `contract-harness.ts`). Each test seeds minimal DB state via the same
 * `main/services/database` functions the server uses, then asserts the SDK call succeeds and
 * returns the unwrapped/typed shape the group's own type signature promises.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeTranscriptsGroup } from '../groups/transcripts'
import { http } from '../http'
import { makeContractApp, installFetchShim, closeContractApp, type ContractApp } from './contract-harness'

describe('transcripts contract', () => {
  let ctx: ContractApp
  const grp = makeTranscriptsGroup({ http })

  beforeEach(async () => {
    ctx = await makeContractApp()
    installFetchShim(ctx.app, ctx.cookie)

    const { insertRecording, upsertTranscriptStage1 } = await import(
      '../../../../electron/main/services/database'
    )
    insertRecording({
      id: 'rec-tx-1',
      filename: 'tx1.hda',
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
    upsertTranscriptStage1({
      recording_id: 'rec-tx-1',
      full_text: 'Hello world from recording one',
      language: 'en',
      word_count: 5,
      transcription_provider: 'gemini',
      transcription_model: 'gemini-pro'
    })
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await closeContractApp(ctx)
  })

  it('getByRecordingId returns the bare transcript object (RAW-THROW)', async () => {
    const result = await grp.getByRecordingId('rec-tx-1')
    expect(result.recording_id).toBe('rec-tx-1')
    expect(result.full_text).toBe('Hello world from recording one')
  })

  it('getByRecordingIds returns a map keyed by recording id, not {items,total}', async () => {
    const result = await grp.getByRecordingIds(['rec-tx-1', 'does-not-exist'])
    expect(Array.isArray(result)).toBe(false)
    expect(result['rec-tx-1'].full_text).toContain('Hello world')
    expect(result['does-not-exist']).toBeUndefined()
  })

  it('search returns a bare array', async () => {
    const result = await grp.search('Hello world')
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBeGreaterThanOrEqual(1)
  })

  it('updateTurns returns a RESULT envelope on success', async () => {
    const result = await grp.updateTurns({
      recordingId: 'rec-tx-1',
      turns: [{ speaker: 'A', startMs: 0, endMs: 1000, text: 'hi' }]
    })
    expect(result.success).toBe(true)
  })

  it('export returns a RESULT envelope with string file content', async () => {
    const result = await grp.export('rec-tx-1', 'json')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(typeof result.data).toBe('string')
      expect(result.data).toContain('Hello world')
    }
  })
})
