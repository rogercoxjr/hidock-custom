/**
 * speakers.contract.test.ts — Layer-2 SDK↔route contract tests for the speakers group.
 *
 * Runs the REAL `makeSpeakersGroup({ http })` (real `http.ts` transport) against the REAL
 * Fastify app (see `contract-harness.ts`). Each test seeds minimal DB state via the same
 * `main/services/database` functions the server uses, then asserts the SDK call succeeds and
 * returns the unwrapped/typed shape the group's own type signature promises.
 *
 * Every speakers method is RESULT (per CONTRACTS.md / groups/speakers.ts), so a happy path
 * asserts `result.success === true` (never a 400/404/405) AND that `result.data` is the bare
 * typed shape — maps stay maps (`getForRecording`), arrays stay arrays (`getSuggestions`), and
 * scalar/object payloads are unwrapped (never a `{items,total}` or double envelope).
 *
 * COVERAGE — all 9 group methods have a safe, no-network happy path and are covered here:
 *   getForRecording, getSuggestions, assign, unassign, merge, reassignTurns, dismissSuggestion,
 *   acceptSuggestion, setSelf.
 *
 * NOTHING IS SKIPPED FOR NETWORK/LLM/MULTIPART/STREAMING, but two nuances are worth recording:
 *   - getSuggestions() runs the voiceprint matcher server-side (dynamic import of
 *     voiceprint-service + speaker-matcher, which embed labels / run the matcher). Under plain
 *     Node/Vitest those dynamic imports degrade and the route's own try/catch returns `[]` on
 *     ANY failure (see routes/speakers.ts:415-448 — "Never throws — returns [] on any failure").
 *     So with no voiceprints seeded the method provably resolves to `[]` without a meaningful
 *     network call; we assert only the RESULT+array invariant, mirroring the server-side test
 *     `electron/server/__tests__/speakers.test.ts` ("returns array (empty when no voiceprints)").
 *   - assign() / merge() / reassignTurns() / setSelf() may fire an OUT-OF-BAND voiceprint
 *     capture via `setImmediate` AFTER the HTTP response returns (routes/speakers.ts:150-170).
 *     It is fire-and-forget and internally try/caught, so it never affects the response we assert
 *     on. The `setSelf` happy path here deliberately exercises the no-self-contact branch, which
 *     schedules no capture at all (routes/speakers.ts:398-401).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeSpeakersGroup } from '../groups/speakers'
import { http } from '../http'
import { makeContractApp, installFetchShim, closeContractApp, type ContractApp } from './contract-harness'

describe('speakers contract', () => {
  let ctx: ContractApp
  const grp = makeSpeakersGroup({ http })

  beforeEach(async () => {
    ctx = await makeContractApp()
    installFetchShim(ctx.app, ctx.cookie)

    const { insertRecording, upsertContact } = await import('../../../../electron/main/services/database')
    const now = new Date().toISOString()

    insertRecording({
      id: 'rec-1',
      filename: 'rec1.hda',
      file_path: null,
      date_recorded: '2024-01-03T10:00:00Z',
      status: 'ready',
      location: 'device-only',
      transcription_status: 'none',
      on_device: 1,
      on_local: 0,
      source: 'hidock',
      is_imported: 0
    })

    upsertContact({
      id: 'contact-1',
      name: 'Alice Smith',
      email: 'alice@example.com',
      type: 'team',
      role: null,
      company: null,
      notes: null,
      tags: null,
      first_seen_at: now,
      last_seen_at: now,
      meeting_count: 0,
      is_self: 0
    })
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await closeContractApp(ctx)
  })

  it('getForRecording returns a RESULT wrapping a label→contact MAP (not an array/{items,total})', async () => {
    // Seed one assignment directly so we can assert the map shape (keyed by file_label).
    const { upsertRecordingSpeaker } = await import('../../../../electron/main/services/database')
    upsertRecordingSpeaker({ recording_id: 'rec-1', file_label: 'A', contact_id: 'contact-1', source: 'user' })

    const result = await grp.getForRecording('rec-1')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(Array.isArray(result.data)).toBe(false)
      expect(result.data.A).toEqual({ contactId: 'contact-1', contactName: 'Alice Smith' })
    }
  })

  it('getForRecording on a recording with no assignments returns an empty MAP (valid happy path)', async () => {
    const result = await grp.getForRecording('rec-1')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(Array.isArray(result.data)).toBe(false)
      expect(result.data).toEqual({})
    }
  })

  it('getSuggestions returns a RESULT wrapping a bare ARRAY, [] with no voiceprints seeded', async () => {
    const result = await grp.getSuggestions('rec-1')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(Array.isArray(result.data)).toBe(true)
      expect(result.data).toEqual([])
    }
  })

  it('assign returns a RESULT wrapping {recordingId,fileLabel,contactId}', async () => {
    const result = await grp.assign({ recordingId: 'rec-1', fileLabel: 'A', contactId: 'contact-1' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual({ recordingId: 'rec-1', fileLabel: 'A', contactId: 'contact-1' })
    }
  })

  it('unassign on a recording with no prior assignment succeeds (RESULT<void>, data undefined)', async () => {
    const result = await grp.unassign({ recordingId: 'rec-1', fileLabel: 'A' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toBeUndefined()
    }
  })

  it('merge returns a RESULT wrapping {recordingId,fromLabel,toLabel}', async () => {
    const { upsertTranscriptStage1 } = await import('../../../../electron/main/services/database')
    upsertTranscriptStage1({
      recording_id: 'rec-1',
      full_text: 'Hello World Bye',
      transcription_provider: 'test',
      turns: [
        { speaker: 'A', startMs: 0, endMs: 1000, text: 'Hello' },
        { speaker: 'B', startMs: 1000, endMs: 2000, text: 'World' },
        { speaker: 'A', startMs: 2000, endMs: 3000, text: 'Bye' }
      ]
    })

    const result = await grp.merge({ recordingId: 'rec-1', fromLabel: 'A', toLabel: 'B' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.recordingId).toBe('rec-1')
      expect(result.data.fromLabel).toBe('A')
      expect(result.data.toLabel).toBe('B')
    }
  })

  it('reassignTurns returns a RESULT wrapping {recordingId,targetLabel,rewrittenCount}', async () => {
    const { upsertTranscriptStage1 } = await import('../../../../electron/main/services/database')
    upsertTranscriptStage1({
      recording_id: 'rec-1',
      full_text: 'Hello World Bye',
      transcription_provider: 'test',
      turns: [
        { speaker: 'A', startMs: 0, endMs: 1000, text: 'Hello' },
        { speaker: 'A', startMs: 1000, endMs: 2000, text: 'World' },
        { speaker: 'A', startMs: 2000, endMs: 3000, text: 'Bye' }
      ]
    })

    const result = await grp.reassignTurns({
      recordingId: 'rec-1',
      sourceLabel: 'A',
      anchorIndex: 1,
      anchorStartMs: 1000,
      scope: 'one',
      target: { kind: 'existingLabel', label: 'B' }
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.recordingId).toBe('rec-1')
      expect(result.data.targetLabel).toBe('B')
      expect(result.data.rewrittenCount).toBe(1)
    }
  })

  it('dismissSuggestion is idempotent for an unknown id and returns a RESULT wrapping {id}', async () => {
    const result = await grp.dismissSuggestion('no-such-suggestion')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual({ id: 'no-such-suggestion' })
    }
  })

  it('acceptSuggestion is idempotent for an unknown id and returns a RESULT wrapping {id}', async () => {
    const result = await grp.acceptSuggestion('no-such-suggestion')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual({ id: 'no-such-suggestion' })
    }
  })

  it('setSelf returns a RESULT wrapping {selfAssigned,needsSelfContact} when no self contact is set', async () => {
    const result = await grp.setSelf({ recordingId: 'rec-1', fileLabel: 'A' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.selfAssigned).toBe(false)
      expect(result.data.needsSelfContact).toBe(true)
    }
  })
})
