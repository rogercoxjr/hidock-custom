import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerSpeakersHandlers, nextUnusedLetter } from '../speakers-handlers'
import { setBroadcaster } from '../../services/broadcaster'
import type { ReassignTurnsRequest } from '../speakers-handlers'
import { ipcMain } from 'electron'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() }
}))

vi.mock('../../services/database', () => ({
  upsertRecordingSpeaker: vi.fn(),
  getRecordingSpeaker: vi.fn(),
  getRecordingSpeakers: vi.fn(() => []),
  deleteRecordingSpeaker: vi.fn(),
  deleteVoiceprintsBySource: vi.fn(),
  getContactById: vi.fn(),
  getTranscriptByRecordingId: vi.fn(),
  updateTranscriptTurns: vi.fn(),
  getPendingSuggestions: vi.fn(),
  getSelfContactId: vi.fn(),
  deleteLabelEmbeddingsForRecording: vi.fn(),
  deleteWindowEmbeddingsForRecording: vi.fn(),
  expireSuggestionsForRecording: vi.fn(),
  acceptSuggestion: vi.fn(),
  dismissSuggestion: vi.fn()
}))

vi.mock('../../services/voiceprint-service', () => ({
  captureVoiceprint: vi.fn(async () => ({ captured: true })),
  embedRecordingLabels: vi.fn(async () => undefined)
}))

vi.mock('../../services/voiceprint/speaker-matcher', () => ({
  runMatcher: vi.fn(async () => ({ summary: {}, diarizationRunId: 'drun_1' }))
}))

const TURNS = [
  { speaker: 'A', startMs: 0, endMs: 1000, text: 'a1' },
  { speaker: 'B', startMs: 1000, endMs: 2000, text: 'b1' },
  { speaker: 'A', startMs: 2000, endMs: 3000, text: 'a2' },
  { speaker: 'A', startMs: 3000, endMs: 4000, text: 'a3' }
]

// Single update point for handler requests: each test overrides only the fields it varies.
function makeReq(overrides: Partial<ReassignTurnsRequest> = {}): ReassignTurnsRequest {
  return {
    recordingId: 'rec-1',
    sourceLabel: 'A',
    anchorIndex: 0,
    anchorStartMs: 0,
    scope: 'one',
    target: { kind: 'existingLabel', label: 'B' },
    ...overrides
  }
}

// AC3 invariant: turns whose speaker !== sourceLabel must appear verbatim, in order, in the
// rewritten array. Survives fixture changes (a bulk-rewrite-everything bug would still produce
// the right array for a specific fixture, but would drop/alter a non-source turn here).
// NOTE: We compare by position (index) rather than by filtering the rewritten array, because
// renamed turns (formerly sourceLabel, now targetLabel) would otherwise appear in the rewritten
// filter and inflate the actual set when the target label matches an existing speaker.
function expectOtherSpeakersTurnsUnchanged(original: any[], rewritten: any[], sourceLabel: string) {
  original.forEach((origTurn, i) => {
    if (origTurn.speaker !== sourceLabel) {
      expect(rewritten[i]).toEqual(origTurn)
    }
  })
}

function getReassignHandler() {
  registerSpeakersHandlers()
  return vi.mocked(ipcMain.handle).mock.calls.find((c) => c[0] === 'speakers:reassignTurns')?.[1]
}

async function seedTurns(turns = TURNS) {
  const db = await import('../../services/database')
  vi.mocked(db.getTranscriptByRecordingId).mockReturnValue({ recording_id: 'rec-1', turns: JSON.stringify(turns) } as any)
  return db
}

describe('nextUnusedLetter', () => {
  it('returns G when A–F are used (highest + 1)', () => {
    expect(nextUnusedLetter(['A', 'B', 'C', 'D', 'E', 'F'])).toBe('G')
  })
  it('tolerates gaps and uses highest + 1', () => {
    expect(nextUnusedLetter(['B', 'D', 'F'])).toBe('G')
  })
  it('returns A when nothing is used', () => {
    expect(nextUnusedLetter([])).toBe('A')
  })
  it('returns B for a single A (gap-free, single-element)', () => {
    expect(nextUnusedLetter(['A'])).toBe('B')
  })
  it('returns null when Z is in use', () => {
    expect(nextUnusedLetter(['A', 'Z'])).toBeNull()
  })
  it('returns null when Z is the ONLY label (highest === Z; catches > vs >=)', () => {
    expect(nextUnusedLetter(['Z'])).toBeNull()
  })
})

describe('speakers:reassignTurns', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setBroadcaster(null)
  })

  it('registers speakers:reassignTurns', () => {
    registerSpeakersHandlers()
    expect(ipcMain.handle).toHaveBeenCalledWith('speakers:reassignTurns', expect.any(Function))
  })

  it("scope 'one' rewrites exactly the anchor turn to an existing label, leaving others", async () => {
    const db = await seedTurns()
    const handler = getReassignHandler()
    const res = await handler?.({} as any, makeReq({ anchorIndex: 2, anchorStartMs: 2000, scope: 'one' })) as any
    expect(res.success).toBe(true)
    expect(res.data).toMatchObject({ targetLabel: 'B', rewrittenCount: 1 })
    const rewritten = vi.mocked(db.updateTranscriptTurns).mock.calls[0][1]
    expect(rewritten).toEqual([
      { speaker: 'A', startMs: 0, endMs: 1000, text: 'a1' },
      { speaker: 'B', startMs: 1000, endMs: 2000, text: 'b1' },
      { speaker: 'B', startMs: 2000, endMs: 3000, text: 'a2' },
      { speaker: 'A', startMs: 3000, endMs: 4000, text: 'a3' }
    ])
    expectOtherSpeakersTurnsUnchanged(TURNS, rewritten, 'A')
  })

  it("scope 'before' rewrites source turns at/earlier than anchor (anchor inclusive), other speakers untouched", async () => {
    const db = await seedTurns()
    const handler = getReassignHandler()
    const res = await handler?.({} as any, makeReq({ anchorIndex: 2, anchorStartMs: 2000, scope: 'before' })) as any
    expect(res.success).toBe(true)
    // A@0 and A@2000 (anchor) move to B; B@1000 untouched; A@3000 (after) stays A.
    const rewritten = vi.mocked(db.updateTranscriptTurns).mock.calls[0][1]
    expect(rewritten).toEqual([
      { speaker: 'B', startMs: 0, endMs: 1000, text: 'a1' },
      { speaker: 'B', startMs: 1000, endMs: 2000, text: 'b1' },
      { speaker: 'B', startMs: 2000, endMs: 3000, text: 'a2' },
      { speaker: 'A', startMs: 3000, endMs: 4000, text: 'a3' }
    ])
    // B@1000 must be byte-identical in the rewritten array (only A's turns may move).
    expectOtherSpeakersTurnsUnchanged(TURNS, rewritten, 'A')
    expect(res.data.rewrittenCount).toBe(2)
  })

  it("scope 'after' rewrites source turns at/later than anchor (anchor inclusive)", async () => {
    const db = await seedTurns()
    const handler = getReassignHandler()
    const res = await handler?.({} as any, makeReq({ anchorIndex: 2, anchorStartMs: 2000, scope: 'after' })) as any
    expect(res.success).toBe(true)
    const rewritten = vi.mocked(db.updateTranscriptTurns).mock.calls[0][1]
    expect(rewritten).toEqual([
      { speaker: 'A', startMs: 0, endMs: 1000, text: 'a1' },
      { speaker: 'B', startMs: 1000, endMs: 2000, text: 'b1' },
      { speaker: 'B', startMs: 2000, endMs: 3000, text: 'a2' },
      { speaker: 'B', startMs: 3000, endMs: 4000, text: 'a3' }
    ])
    expectOtherSpeakersTurnsUnchanged(TURNS, rewritten, 'A')
    expect(res.data.rewrittenCount).toBe(2)
  })

  it("target 'newSpeaker' mints the next unused letter (A,B used -> C) with no mapping", async () => {
    const db = await seedTurns()
    const handler = getReassignHandler()
    const res = await handler?.({} as any, makeReq({ target: { kind: 'newSpeaker' } })) as any
    expect(res.success).toBe(true)
    expect(res.data.targetLabel).toBe('C')
    expect(db.upsertRecordingSpeaker).not.toHaveBeenCalled()
  })

  it("target 'contact' reuses an existing recording_speakers letter for that contact", async () => {
    const db = await seedTurns()
    vi.mocked(db.getContactById).mockReturnValue({ id: 'cB', name: 'Bob' } as any)
    vi.mocked(db.getRecordingSpeakers).mockReturnValue([
      { recording_id: 'rec-1', file_label: 'B', contact_id: 'cB', confidence: null, source: 'user', created_at: 't' }
    ] as any)
    const handler = getReassignHandler()
    const res = await handler?.({} as any, makeReq({ target: { kind: 'contact', contactId: 'cB' } })) as any
    expect(res.success).toBe(true)
    expect(res.data.targetLabel).toBe('B')
    // Reuses existing letter — no new upsert, no new capture.
    expect(db.upsertRecordingSpeaker).not.toHaveBeenCalled()
  })

  it("target 'contact' with no existing letter mints next letter AND schedules capture (assign path)", async () => {
    const db = await seedTurns()
    const voiceprint = await import('../../services/voiceprint-service')
    vi.mocked(db.getContactById).mockReturnValue({ id: 'cZ', name: 'Zoe' } as any)
    vi.mocked(db.getRecordingSpeakers).mockReturnValue([] as any)
    const handler = getReassignHandler()
    const res = await handler?.({} as any, makeReq({ target: { kind: 'contact', contactId: 'cZ' } })) as any
    expect(res.success).toBe(true)
    // A,B used -> mint C and map it to the contact via the assign path.
    expect(res.data.targetLabel).toBe('C')
    expect(db.upsertRecordingSpeaker).toHaveBeenCalledWith(
      expect.objectContaining({ recording_id: 'rec-1', file_label: 'C', contact_id: 'cZ', source: 'user' })
    )
    await new Promise((r) => setImmediate(r))
    expect(voiceprint.captureVoiceprint).toHaveBeenCalledWith('rec-1', 'C', 'cZ', 'manual')
  })

  it('deletes the source recording_speakers row when the source label is emptied', async () => {
    // Source A has ONLY turns; move every A turn away so A becomes orphaned.
    const onlyA = [
      { speaker: 'A', startMs: 0, endMs: 1000, text: 'a1' },
      { speaker: 'A', startMs: 1000, endMs: 2000, text: 'a2' }
    ]
    const db = await seedTurns(onlyA)
    const handler = getReassignHandler()
    const res = await handler?.({} as any, makeReq({ anchorIndex: 1, anchorStartMs: 1000, scope: 'before' })) as any
    expect(res.success).toBe(true)
    expect(db.deleteRecordingSpeaker).toHaveBeenCalledWith('rec-1', 'A')
  })

  it('does NOT delete the source row when source still has turns (A survives in rewritten array)', async () => {
    const db = await seedTurns()
    const handler = getReassignHandler()
    await handler?.({} as any, makeReq({ anchorIndex: 0, anchorStartMs: 0, scope: 'one' }))
    // Strengthen the absence-of-call assertion: prove A is still present so the precondition
    // ("source still has turns") is real, not vacuous.
    const rewritten = vi.mocked(db.updateTranscriptTurns).mock.calls[0][1]
    expect(rewritten.some((t: any) => t.speaker === 'A')).toBe(true)
    expect(db.deleteRecordingSpeaker).not.toHaveBeenCalledWith('rec-1', 'A')
  })

  it('invalidates the same embedding/suggestion set as merge', async () => {
    const db = await seedTurns()
    const handler = getReassignHandler()
    await handler?.({} as any, makeReq({ anchorIndex: 0, anchorStartMs: 0, scope: 'one' }))
    expect(db.deleteLabelEmbeddingsForRecording).toHaveBeenCalledWith('rec-1')
    expect(db.deleteWindowEmbeddingsForRecording).toHaveBeenCalledWith('rec-1')
    expect(db.expireSuggestionsForRecording).toHaveBeenCalledWith('rec-1')
    // NOTE: clearSuggestionsInFlight is a LOCAL function in speakers-handlers.ts (line 65),
    // NOT a database export, so it cannot be spied/asserted via the db mock above. It is the
    // subtlest of the four invalidators; the handler MUST still call it (spec §4.4 step 6 +
    // Global Constraints). It is exercised indirectly by the SourceReader refresh test in
    // Task 3 (getSuggestions re-runs after reassign). Do NOT drop the call in a refactor.
  })

  it('rejects a stale anchor (startMs mismatch) with VALIDATION_ERROR and no write', async () => {
    const db = await seedTurns()
    const handler = getReassignHandler()
    const res = await handler?.({} as any, makeReq({ anchorIndex: 2, anchorStartMs: 9999, scope: 'one' })) as any
    expect(res.success).toBe(false)
    expect(res.error.code).toBe('VALIDATION_ERROR')
    expect(db.updateTranscriptTurns).not.toHaveBeenCalled()
  })

  it('rejects a stale anchor (speaker mismatch) with VALIDATION_ERROR and no write', async () => {
    const db = await seedTurns()
    const handler = getReassignHandler()
    const res = await handler?.({} as any, makeReq({ anchorIndex: 1, anchorStartMs: 1000, scope: 'one' })) as any
    expect(res.success).toBe(false)
    expect(res.error.code).toBe('VALIDATION_ERROR')
    expect(db.updateTranscriptTurns).not.toHaveBeenCalled()
  })

  it('rejects an out-of-bounds anchor (index past end -> turns[anchorIndex] undefined) with no write', async () => {
    // Simulates a stale index after a prior reassign deleted turns: turns[99] is undefined,
    // so the !anchor branch must fire BEFORE the startMs/speaker checks (which would crash on
    // a property access). VALIDATION_ERROR, no write.
    const db = await seedTurns()
    const handler = getReassignHandler()
    const res = await handler?.({} as any, makeReq({ anchorIndex: 99, anchorStartMs: 0, scope: 'one' })) as any
    expect(res.success).toBe(false)
    expect(res.error.code).toBe('VALIDATION_ERROR')
    expect(db.updateTranscriptTurns).not.toHaveBeenCalled()
  })
})
