import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerSpeakersHandlers, setMainWindowForSpeakers } from '../speakers-handlers'
import { ipcMain } from 'electron'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() }
}))

vi.mock('../../services/database', () => ({
  upsertRecordingSpeaker: vi.fn(),
  getRecordingSpeaker: vi.fn(),
  getRecordingSpeakers: vi.fn(),
  deleteRecordingSpeaker: vi.fn(),
  deleteVoiceprintsBySource: vi.fn(),
  getContactById: vi.fn(),
  getTranscriptByRecordingId: vi.fn(),
  updateTranscriptTurns: vi.fn(),
  getPendingSuggestions: vi.fn(),
  getSelfContactId: vi.fn(),
  deleteLabelEmbeddingsForRecording: vi.fn(),
  expireSuggestionsForRecording: vi.fn(),
  acceptSuggestion: vi.fn(),
  dismissSuggestion: vi.fn()
}))

vi.mock('../../services/voiceprint-service', () => ({
  captureVoiceprint: vi.fn(async () => ({ captured: true })),
  embedRecordingLabels: vi.fn(async () => undefined)
}))

vi.mock('../../services/voiceprint/speaker-matcher', () => ({
  runMatcher: vi.fn(async () => ({ summary: { identity: 0, merge: 0, mixed: 0, skippedModelMismatch: 0 }, diarizationRunId: 'drun_1' }))
}))

describe('Speakers IPC Handlers (AC3/AC4)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('registers speakers:assign', () => {
    registerSpeakersHandlers()
    expect(ipcMain.handle).toHaveBeenCalledWith('speakers:assign', expect.any(Function))
  })

  it('writes a recording_speakers row with source="user"', async () => {
    const { upsertRecordingSpeaker, getContactById } = await import('../../services/database')
    vi.mocked(getContactById).mockReturnValue({ id: 'c-1', name: 'Alice' } as any)

    registerSpeakersHandlers()
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(c => c[0] === 'speakers:assign')?.[1]
    const result = await handler?.({} as any, { recordingId: 'rec-1', fileLabel: 'A', contactId: 'c-1' }) as any

    expect(result.success).toBe(true)
    expect(upsertRecordingSpeaker).toHaveBeenCalledWith(
      expect.objectContaining({ recording_id: 'rec-1', file_label: 'A', contact_id: 'c-1', source: 'user' })
    )
  })

  it('rejects when contactId does not resolve to a contact', async () => {
    const { upsertRecordingSpeaker, getContactById } = await import('../../services/database')
    vi.mocked(getContactById).mockReturnValue(undefined)

    registerSpeakersHandlers()
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(c => c[0] === 'speakers:assign')?.[1]
    const result = await handler?.({} as any, { recordingId: 'rec-1', fileLabel: 'A', contactId: 'missing' }) as any

    expect(result.success).toBe(false)
    expect(result.error.code).toBe('NOT_FOUND')
    expect(upsertRecordingSpeaker).not.toHaveBeenCalled()
  })

  it('rejects a missing fileLabel (validation)', async () => {
    const { upsertRecordingSpeaker } = await import('../../services/database')
    registerSpeakersHandlers()
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(c => c[0] === 'speakers:assign')?.[1]
    const result = await handler?.({} as any, { recordingId: 'rec-1', fileLabel: '', contactId: 'c-1' }) as any

    expect(result.success).toBe(false)
    expect(result.error.code).toBe('VALIDATION_ERROR')
    expect(upsertRecordingSpeaker).not.toHaveBeenCalled()
  })
})

describe('speakers:merge (AC3 — server-side merge, no orphan rows)', () => {
  beforeEach(() => vi.clearAllMocks())

  function getMergeHandler() {
    registerSpeakersHandlers()
    return vi.mocked(ipcMain.handle).mock.calls.find(c => c[0] === 'speakers:merge')?.[1]
  }

  it('registers speakers:merge', () => {
    registerSpeakersHandlers()
    expect(ipcMain.handle).toHaveBeenCalledWith('speakers:merge', expect.any(Function))
  })

  it('rewrites turns C -> A, persists them, and deletes the from-label mapping (no orphan)', async () => {
    const db = await import('../../services/database')
    vi.mocked(db.getTranscriptByRecordingId).mockReturnValue({
      recording_id: 'rec-1',
      turns: JSON.stringify([
        { speaker: 'A', startMs: 0, endMs: 1000, text: 'a' },
        { speaker: 'C', startMs: 1000, endMs: 2000, text: 'c' }
      ])
    } as any)
    // A is already mapped; C is mapped (the orphan we will delete).
    vi.mocked(db.getRecordingSpeakers).mockReturnValue([
      { recording_id: 'rec-1', file_label: 'A', contact_id: 'cA', confidence: null, source: 'user', created_at: 't' },
      { recording_id: 'rec-1', file_label: 'C', contact_id: 'cC', confidence: null, source: 'user', created_at: 't' }
    ] as any)

    const handler = getMergeHandler()
    const result = await handler?.({} as any, { recordingId: 'rec-1', fromLabel: 'C', toLabel: 'A' }) as any

    expect(result.success).toBe(true)

    // Turns persisted with every C rewritten to A.
    expect(db.updateTranscriptTurns).toHaveBeenCalledWith(
      'rec-1',
      [
        { speaker: 'A', startMs: 0, endMs: 1000, text: 'a' },
        { speaker: 'A', startMs: 1000, endMs: 2000, text: 'c' }
      ]
    )
    // The from-label mapping is deleted (Issue 3 — no orphaned recording_speakers row).
    expect(db.deleteRecordingSpeaker).toHaveBeenCalledWith('rec-1', 'C')
  })

  it('upserts the target mapping when toLabel had no row but fromLabel did (preserve mapping)', async () => {
    const db = await import('../../services/database')
    vi.mocked(db.getTranscriptByRecordingId).mockReturnValue({
      recording_id: 'rec-2',
      turns: JSON.stringify([
        { speaker: 'A', startMs: 0, endMs: 1000, text: 'a' },
        { speaker: 'C', startMs: 1000, endMs: 2000, text: 'c' }
      ])
    } as any)
    // Only C is mapped; A has no row yet — merge should carry C's contact onto A.
    vi.mocked(db.getRecordingSpeakers).mockReturnValue([
      { recording_id: 'rec-2', file_label: 'C', contact_id: 'cC', confidence: null, source: 'user', created_at: 't' }
    ] as any)

    const handler = getMergeHandler()
    const result = await handler?.({} as any, { recordingId: 'rec-2', fromLabel: 'C', toLabel: 'A' }) as any

    expect(result.success).toBe(true)
    expect(db.upsertRecordingSpeaker).toHaveBeenCalledWith(
      expect.objectContaining({ recording_id: 'rec-2', file_label: 'A', contact_id: 'cC', source: 'user' })
    )
    expect(db.deleteRecordingSpeaker).toHaveBeenCalledWith('rec-2', 'C')
  })

  it('rejects when the transcript has no turns', async () => {
    const db = await import('../../services/database')
    vi.mocked(db.getTranscriptByRecordingId).mockReturnValue({ recording_id: 'rec-3', turns: null } as any)

    const handler = getMergeHandler()
    const result = await handler?.({} as any, { recordingId: 'rec-3', fromLabel: 'C', toLabel: 'A' }) as any

    expect(result.success).toBe(false)
    expect(db.updateTranscriptTurns).not.toHaveBeenCalled()
  })

  it('rejects fromLabel === toLabel (validation)', async () => {
    const db = await import('../../services/database')
    const handler = getMergeHandler()
    const result = await handler?.({} as any, { recordingId: 'rec-4', fromLabel: 'A', toLabel: 'A' }) as any

    expect(result.success).toBe(false)
    expect(result.error.code).toBe('VALIDATION_ERROR')
    expect(db.updateTranscriptTurns).not.toHaveBeenCalled()
  })
})

describe('transcripts:updateTurns (AC3 — per-turn reassign persistence)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('registers transcripts:updateTurns', () => {
    registerSpeakersHandlers()
    expect(ipcMain.handle).toHaveBeenCalledWith('transcripts:updateTurns', expect.any(Function))
  })

  it('persists the supplied turns array verbatim via updateTranscriptTurns', async () => {
    const db = await import('../../services/database')
    registerSpeakersHandlers()
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(c => c[0] === 'transcripts:updateTurns')?.[1]

    const turns = [
      { speaker: 'A', startMs: 0, endMs: 1000, text: 'a' },
      { speaker: 'B', startMs: 1000, endMs: 2000, text: 'b' } // reassigned from A -> B; others unchanged
    ]
    const result = await handler?.({} as any, { recordingId: 'rec-1', turns }) as any

    expect(result.success).toBe(true)
    expect(db.updateTranscriptTurns).toHaveBeenCalledWith('rec-1', turns)
  })

  it('rejects an empty recordingId (validation)', async () => {
    const db = await import('../../services/database')
    registerSpeakersHandlers()
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(c => c[0] === 'transcripts:updateTurns')?.[1]
    const result = await handler?.({} as any, { recordingId: '', turns: [] }) as any

    expect(result.success).toBe(false)
    expect(result.error.code).toBe('VALIDATION_ERROR')
    expect(db.updateTranscriptTurns).not.toHaveBeenCalled()
  })

  it('rejects a malformed turns payload (data integrity — not persisted)', async () => {
    const db = await import('../../services/database')
    registerSpeakersHandlers()
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(c => c[0] === 'transcripts:updateTurns')?.[1]

    // Each entry is missing required Turn fields (no startMs/endMs/text, wrong types).
    const malformed = [
      { speaker: 'A' }, // missing startMs/endMs/text
      { speaker: 'B', startMs: 'oops', endMs: 1000, text: 'x' } // startMs wrong type
    ]
    const result = await handler?.({} as any, { recordingId: 'rec-1', turns: malformed }) as any

    expect(result.success).toBe(false)
    expect(result.error.code).toBe('VALIDATION_ERROR')
    // Critically: nothing was written to the DB.
    expect(db.updateTranscriptTurns).not.toHaveBeenCalled()
  })

  it('rejects an invalid sentiment enum value (data integrity)', async () => {
    const db = await import('../../services/database')
    registerSpeakersHandlers()
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(c => c[0] === 'transcripts:updateTurns')?.[1]

    const badSentiment = [
      { speaker: 'A', startMs: 0, endMs: 1000, text: 'a', sentiment: 'HAPPY' } // not in enum
    ]
    const result = await handler?.({} as any, { recordingId: 'rec-1', turns: badSentiment }) as any

    expect(result.success).toBe(false)
    expect(result.error.code).toBe('VALIDATION_ERROR')
    expect(db.updateTranscriptTurns).not.toHaveBeenCalled()
  })

  it('accepts a well-formed turn with optional words + sentiment', async () => {
    const db = await import('../../services/database')
    registerSpeakersHandlers()
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(c => c[0] === 'transcripts:updateTurns')?.[1]

    const turns = [
      {
        speaker: 'A',
        startMs: 0,
        endMs: 1000,
        text: 'a',
        words: [{ text: 'a', startMs: 0, endMs: 1000 }],
        sentiment: 'POSITIVE'
      }
    ]
    const result = await handler?.({} as any, { recordingId: 'rec-1', turns }) as any

    expect(result.success).toBe(true)
    expect(db.updateTranscriptTurns).toHaveBeenCalledWith('rec-1', turns)
  })
})

describe('speakers:getForRecording (panel display + live refresh)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('registers speakers:getForRecording', () => {
    registerSpeakersHandlers()
    expect(ipcMain.handle).toHaveBeenCalledWith('speakers:getForRecording', expect.any(Function))
  })

  it('returns a label -> { contactId, contactName } map joined from contacts', async () => {
    const db = await import('../../services/database')
    vi.mocked(db.getRecordingSpeakers).mockReturnValue([
      { recording_id: 'rec-1', file_label: 'A', contact_id: 'cA', confidence: null, source: 'user', created_at: 't' },
      { recording_id: 'rec-1', file_label: 'B', contact_id: 'cB', confidence: null, source: 'user', created_at: 't' }
    ] as any)
    vi.mocked(db.getContactById).mockImplementation((id: string) => {
      if (id === 'cA') return { id: 'cA', name: 'Alice' } as any
      if (id === 'cB') return { id: 'cB', name: 'Bob' } as any
      return undefined
    })

    registerSpeakersHandlers()
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(c => c[0] === 'speakers:getForRecording')?.[1]
    const result = await handler?.({} as any, 'rec-1') as any

    expect(result.success).toBe(true)
    expect(result.data).toEqual({
      A: { contactId: 'cA', contactName: 'Alice' },
      B: { contactId: 'cB', contactName: 'Bob' }
    })
  })

  it('omits rows whose contact_id is null or no longer resolves', async () => {
    const db = await import('../../services/database')
    vi.mocked(db.getRecordingSpeakers).mockReturnValue([
      { recording_id: 'rec-1', file_label: 'A', contact_id: 'cA', confidence: null, source: 'user', created_at: 't' },
      { recording_id: 'rec-1', file_label: 'B', contact_id: null, confidence: null, source: 'user', created_at: 't' },
      { recording_id: 'rec-1', file_label: 'C', contact_id: 'gone', confidence: null, source: 'user', created_at: 't' }
    ] as any)
    vi.mocked(db.getContactById).mockImplementation((id: string) =>
      id === 'cA' ? ({ id: 'cA', name: 'Alice' } as any) : undefined
    )

    registerSpeakersHandlers()
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(c => c[0] === 'speakers:getForRecording')?.[1]
    const result = await handler?.({} as any, 'rec-1') as any

    expect(result.success).toBe(true)
    expect(result.data).toEqual({ A: { contactId: 'cA', contactName: 'Alice' } })
  })

  it('rejects an empty recordingId (validation)', async () => {
    registerSpeakersHandlers()
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(c => c[0] === 'speakers:getForRecording')?.[1]
    const result = await handler?.({} as any, '') as any

    expect(result.success).toBe(false)
    expect(result.error.code).toBe('VALIDATION_ERROR')
  })
})

describe('Phase 2A reassign auto-purge, unassign, and voiceprint:captured event', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setMainWindowForSpeakers(null as any)
  })

  function getAssignHandler() {
    registerSpeakersHandlers()
    return vi.mocked(ipcMain.handle).mock.calls.find(c => c[0] === 'speakers:assign')?.[1]
  }

  it('reassign from cA to cB purges prior voiceprints synchronously and emits purge fields', async () => {
    const db = await import('../../services/database')
    const voiceprint = await import('../../services/voiceprint-service')
    vi.mocked(db.getContactById).mockReturnValue({ id: 'cB', name: 'Bob' } as any)
    vi.mocked(db.getRecordingSpeaker).mockReturnValue({ contact_id: 'cA' } as any)
    vi.mocked(db.deleteVoiceprintsBySource).mockReturnValue(2)
    vi.mocked(voiceprint.captureVoiceprint).mockResolvedValue({
      captured: true,
      reason: 'clean-speech',
      cleanSpeechMs: 1500,
      voiceprintId: 'vp-2'
    } as any)

    const send = vi.fn()
    setMainWindowForSpeakers({
      isDestroyed: () => false,
      webContents: { send }
    } as any)

    const handler = getAssignHandler()
    const result = await handler?.({} as any, { recordingId: 'rec-1', fileLabel: 'A', contactId: 'cB' }) as any

    expect(result.success).toBe(true)
    // Purge runs synchronously before the deferred setImmediate capture.
    expect(db.deleteVoiceprintsBySource).toHaveBeenCalledWith('rec-1', 'A', 'cA')
    expect(db.deleteVoiceprintsBySource).not.toHaveBeenCalledWith('rec-1', 'A', 'cB')

    await new Promise((resolve) => setImmediate(resolve))

    expect(send).toHaveBeenCalledWith(
      'voiceprint:captured',
      expect.objectContaining({
        recordingId: 'rec-1',
        fileLabel: 'A',
        contactId: 'cB',
        captured: true,
        reason: 'clean-speech',
        cleanSpeechMs: 1500,
        voiceprintId: 'vp-2',
        purgedPriorContactId: 'cA',
        purgedCount: 2
      })
    )
  })

  it('same-contact reassign does not purge voiceprints', async () => {
    const db = await import('../../services/database')
    vi.mocked(db.getContactById).mockReturnValue({ id: 'cA', name: 'Alice' } as any)
    vi.mocked(db.getRecordingSpeaker).mockReturnValue({ contact_id: 'cA' } as any)

    const handler = getAssignHandler()
    const result = await handler?.({} as any, { recordingId: 'rec-1', fileLabel: 'A', contactId: 'cA' }) as any

    expect(result.success).toBe(true)
    expect(db.deleteVoiceprintsBySource).not.toHaveBeenCalled()
  })

  it('first assignment does not purge voiceprints', async () => {
    const db = await import('../../services/database')
    vi.mocked(db.getContactById).mockReturnValue({ id: 'cA', name: 'Alice' } as any)
    vi.mocked(db.getRecordingSpeaker).mockReturnValue(undefined)

    const handler = getAssignHandler()
    const result = await handler?.({} as any, { recordingId: 'rec-1', fileLabel: 'A', contactId: 'cA' }) as any

    expect(result.success).toBe(true)
    expect(db.deleteVoiceprintsBySource).not.toHaveBeenCalled()
  })

  it('registers speakers:unassign, reads prior contact, deletes mapping, and returns success', async () => {
    const db = await import('../../services/database')
    vi.mocked(db.getRecordingSpeaker).mockReturnValue({ contact_id: 'cA' } as any)

    registerSpeakersHandlers()
    expect(ipcMain.handle).toHaveBeenCalledWith('speakers:unassign', expect.any(Function))

    const handler = vi.mocked(ipcMain.handle).mock.calls.find(c => c[0] === 'speakers:unassign')?.[1]
    const result = await handler?.({} as any, { recordingId: 'rec-1', fileLabel: 'A' }) as any

    expect(result.success).toBe(true)
    expect(db.getRecordingSpeaker).toHaveBeenCalledWith('rec-1', 'A')
    expect(db.deleteRecordingSpeaker).toHaveBeenCalledWith('rec-1', 'A')
  })

  it('voiceprint:captured event is sent with correct payload when mainWindow is set and not destroyed', async () => {
    const db = await import('../../services/database')
    const voiceprint = await import('../../services/voiceprint-service')
    vi.mocked(db.getContactById).mockReturnValue({ id: 'c-1', name: 'Alice' } as any)
    vi.mocked(db.getRecordingSpeaker).mockReturnValue(undefined)
    vi.mocked(voiceprint.captureVoiceprint).mockResolvedValue({
      captured: true,
      reason: 'clean-speech',
      cleanSpeechMs: 1234,
      voiceprintId: 'vp-new'
    } as any)

    const send = vi.fn()
    setMainWindowForSpeakers({
      isDestroyed: () => false,
      webContents: { send }
    } as any)

    const handler = getAssignHandler()
    await handler?.({} as any, { recordingId: 'rec-1', fileLabel: 'A', contactId: 'c-1' })

    await new Promise((resolve) => setImmediate(resolve))

    expect(send).toHaveBeenCalledWith(
      'voiceprint:captured',
      expect.objectContaining({
        recordingId: 'rec-1',
        fileLabel: 'A',
        contactId: 'c-1',
        captured: true,
        reason: 'clean-speech',
        cleanSpeechMs: 1234,
        voiceprintId: 'vp-new'
      })
    )
  })

  it('does not reject the assign IPC when mainWindow is destroyed', async () => {
    const db = await import('../../services/database')
    vi.mocked(db.getContactById).mockReturnValue({ id: 'c-1', name: 'Alice' } as any)
    vi.mocked(db.getRecordingSpeaker).mockReturnValue(undefined)

    const send = vi.fn()
    setMainWindowForSpeakers({
      isDestroyed: () => true,
      webContents: { send }
    } as any)

    const handler = getAssignHandler()
    const result = await handler?.({} as any, { recordingId: 'rec-1', fileLabel: 'A', contactId: 'c-1' }) as any

    expect(result.success).toBe(true)

    await new Promise((resolve) => setImmediate(resolve))

    expect(send).not.toHaveBeenCalled()
  })
})

describe('Sub-project B: matcher suggestions IPC wiring', () => {
  beforeEach(() => vi.clearAllMocks())

  it('speakers:getSuggestions embeds, matches, and returns shaped views', async () => {
    const db = await import('../../services/database')
    const voiceprint = await import('../../services/voiceprint-service')
    const matcher = await import('../../services/voiceprint/speaker-matcher')

    vi.mocked(db.getPendingSuggestions).mockReturnValue([
      {
        id: 's1',
        recording_id: 'rec-1',
        kind: 'identity',
        target_label: 'A',
        contact_id: 'c-1',
        score: 0.8,
        rank: 1,
        rationale: 'strong match',
        status: 'pending'
      },
      {
        id: 's2',
        recording_id: 'rec-1',
        kind: 'merge',
        target_label: 'A',
        target_label_2: 'B',
        contact_id: null,
        score: 0.7,
        rank: 3,
        rationale: 'merges cA and cB',
        status: 'pending'
      }
    ] as any)
    vi.mocked(db.getContactById).mockImplementation((id: string) =>
      id === 'c-1' ? ({ id: 'c-1', name: 'Robyn' } as any) : undefined
    )

    registerSpeakersHandlers()
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(c => c[0] === 'speakers:getSuggestions')?.[1]
    const result = await handler?.({} as any, 'rec-1') as any

    expect(voiceprint.embedRecordingLabels).toHaveBeenCalledWith('rec-1')
    expect(matcher.runMatcher).toHaveBeenCalledWith('rec-1')
    expect(db.getPendingSuggestions).toHaveBeenCalledWith('rec-1', 'drun_1')
    expect(result.success).toBe(true)
    expect(result.data).toHaveLength(2)
    expect(result.data[0]).toMatchObject({
      id: 's1',
      kind: 'identity',
      targetLabel: 'A',
      contactName: 'Robyn',
      requiresWarning: false
    })
    expect(result.data[1]).toMatchObject({
      id: 's2',
      kind: 'merge',
      targetLabel: 'A',
      targetLabel2: 'B',
      requiresWarning: true
    })
  })

  it('speakers:dismissSuggestion marks a suggestion dismissed', async () => {
    const db = await import('../../services/database')
    registerSpeakersHandlers()
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(c => c[0] === 'speakers:dismissSuggestion')?.[1]

    const result = await handler?.({} as any, 's-1') as any
    expect(result.success).toBe(true)
    expect(db.dismissSuggestion).toHaveBeenCalledWith('s-1')
  })

  it('speakers:acceptSuggestion marks a suggestion accepted', async () => {
    const db = await import('../../services/database')
    registerSpeakersHandlers()
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(c => c[0] === 'speakers:acceptSuggestion')?.[1]

    const result = await handler?.({} as any, 's-2') as any
    expect(result.success).toBe(true)
    expect(db.acceptSuggestion).toHaveBeenCalledWith('s-2')
  })

  it('speakers:setSelf returns needsSelfContact when no self contact exists', async () => {
    const db = await import('../../services/database')
    vi.mocked(db.getSelfContactId).mockReturnValue(null)

    registerSpeakersHandlers()
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(c => c[0] === 'speakers:setSelf')?.[1]

    const result = await handler?.({} as any, { recordingId: 'rec-1', fileLabel: 'A' }) as any
    expect(result.success).toBe(true)
    expect(result.data).toEqual({ selfAssigned: false, needsSelfContact: true })
    expect(db.upsertRecordingSpeaker).not.toHaveBeenCalled()
  })

  it('speakers:setSelf assigns confirmed and banks a self print', async () => {
    const db = await import('../../services/database')
    const voiceprint = await import('../../services/voiceprint-service')
    vi.mocked(db.getSelfContactId).mockReturnValue('self-1')

    registerSpeakersHandlers()
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(c => c[0] === 'speakers:setSelf')?.[1]

    const result = await handler?.({} as any, { recordingId: 'rec-1', fileLabel: 'A' }) as any
    expect(result.success).toBe(true)
    expect(result.data).toEqual({ selfAssigned: true, contactId: 'self-1' })
    expect(db.upsertRecordingSpeaker).toHaveBeenCalledWith(
      expect.objectContaining({
        recording_id: 'rec-1',
        file_label: 'A',
        contact_id: 'self-1',
        source: 'confirmed'
      })
    )

    await new Promise((resolve) => setImmediate(resolve))
    expect(voiceprint.captureVoiceprint).toHaveBeenCalledWith('rec-1', 'A', 'self-1', 'self')
  })

  it('speakers:assign with suggestion_confirmed source writes that source and banks a confirmed print', async () => {
    const db = await import('../../services/database')
    const voiceprint = await import('../../services/voiceprint-service')
    vi.mocked(db.getContactById).mockReturnValue({ id: 'c-1', name: 'Robyn' } as any)
    vi.mocked(db.getRecordingSpeaker).mockReturnValue(undefined)

    registerSpeakersHandlers()
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(c => c[0] === 'speakers:assign')?.[1]

    const result = await handler?.({} as any, {
      recordingId: 'rec-1',
      fileLabel: 'A',
      contactId: 'c-1',
      source: 'suggestion_confirmed'
    }) as any

    expect(result.success).toBe(true)
    expect(db.upsertRecordingSpeaker).toHaveBeenCalledWith(
      expect.objectContaining({ recording_id: 'rec-1', file_label: 'A', contact_id: 'c-1', source: 'suggestion_confirmed' })
    )

    await new Promise((resolve) => setImmediate(resolve))
    expect(voiceprint.captureVoiceprint).toHaveBeenCalledWith('rec-1', 'A', 'c-1', 'confirmed')
  })

  it('speakers:merge invalidates label embeddings and expires suggestions', async () => {
    const db = await import('../../services/database')
    vi.mocked(db.getTranscriptByRecordingId).mockReturnValue({
      recording_id: 'rec-1',
      turns: JSON.stringify([
        { speaker: 'A', startMs: 0, endMs: 1000, text: 'a' },
        { speaker: 'B', startMs: 1000, endMs: 2000, text: 'b' }
      ])
    } as any)
    vi.mocked(db.getRecordingSpeakers).mockReturnValue([
      { recording_id: 'rec-1', file_label: 'A', contact_id: 'cA', source: 'user' },
      { recording_id: 'rec-1', file_label: 'B', contact_id: 'cB', source: 'user' }
    ] as any)

    registerSpeakersHandlers()
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(c => c[0] === 'speakers:merge')?.[1]

    const result = await handler?.({} as any, { recordingId: 'rec-1', fromLabel: 'B', toLabel: 'A' }) as any
    expect(result.success).toBe(true)
    expect(db.deleteLabelEmbeddingsForRecording).toHaveBeenCalledWith('rec-1')
    expect(db.expireSuggestionsForRecording).toHaveBeenCalledWith('rec-1')
  })
})
