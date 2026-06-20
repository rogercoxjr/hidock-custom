import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerVoiceprintsHandlers } from '../voiceprints-handlers'
import { ipcMain } from 'electron'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() }
}))

vi.mock('../../services/database', () => ({
  getVoiceprintsByContactId: vi.fn(),
  getVoiceprintsBySource: vi.fn(),
  getRecordingById: vi.fn(),
  getKnowledgeCaptureByRecordingId: vi.fn(),
  disableVoiceprint: vi.fn(),
  enableVoiceprint: vi.fn(),
  deleteVoiceprint: vi.fn(),
  deleteVoiceprintsByContactId: vi.fn(),
  deleteAllVoiceprints: vi.fn()
}))

const contactId = '550e8400-e29b-41d4-a716-446655440000'
const voiceprintId = '660e8400-e29b-41d4-a716-446655440000'
const recordingId = '770e8400-e29b-41d4-a716-446655440000'

function makeMockVoiceprint(overrides: Partial<any> = {}): any {
  return {
    id: voiceprintId,
    contact_id: contactId,
    model_id: 'eres2net',
    dim: 256,
    embedding: new Uint8Array([1, 2, 3]),
    created_at: '2026-06-19T00:00:00.000Z',
    source_recording_id: recordingId,
    source_label: 'A',
    clean_speech_ms: 1234,
    quality_score: null,
    model_version: 1,
    created_from: 'manual',
    disabled_at: null,
    superseded_by: null,
    ...overrides
  }
}

describe('Voiceprints IPC Handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('registers all expected channels', () => {
    registerVoiceprintsHandlers()
    expect(ipcMain.handle).toHaveBeenCalledWith('voiceprints:listForContact', expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith('voiceprints:disable', expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith('voiceprints:enable', expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith('voiceprints:delete', expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith('voiceprints:clearAllForContact', expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith('voiceprints:clearAll', expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith('voiceprints:findBySource', expect.any(Function))
  })

  describe('voiceprints:listForContact', () => {
    function getHandler() {
      registerVoiceprintsHandlers()
      return vi.mocked(ipcMain.handle).mock.calls.find(c => c[0] === 'voiceprints:listForContact')?.[1]
    }

    it('projects to VoiceprintSummary without the embedding field', async () => {
      const db = await import('../../services/database')
      vi.mocked(db.getVoiceprintsByContactId).mockReturnValue([makeMockVoiceprint()])
      vi.mocked(db.getRecordingById).mockReturnValue({ id: recordingId, filename: 'rec.mp3' } as any)

      const handler = getHandler()
      const result = await handler?.({} as any, { contactId }) as any

      expect(result.success).toBe(true)
      expect(result.data).toHaveLength(1)
      const summary = result.data[0]
      expect(summary.id).toBe(voiceprintId)
      expect(summary.contactId).toBe(contactId)
      expect(summary.modelId).toBe('eres2net')
      expect(summary.sourceRecordingId).toBe(recordingId)
      expect(summary.sourceLabel).toBe('A')
      expect(summary.cleanSpeechMs).toBe(1234)
      expect(summary.createdFrom).toBe('manual')
      expect(summary.disabledAt).toBeNull()
      expect(summary).not.toHaveProperty('embedding')
    })

    it('resolves sourceRecordingTitle from knowledge-capture title when present', async () => {
      const db = await import('../../services/database')
      vi.mocked(db.getVoiceprintsByContactId).mockReturnValue([makeMockVoiceprint()])
      vi.mocked(db.getRecordingById).mockReturnValue({ id: recordingId, filename: 'rec.mp3' } as any)
      vi.mocked(db.getKnowledgeCaptureByRecordingId).mockReturnValue({ title: 'Quarterly Planning' } as any)

      const handler = getHandler()
      const result = await handler?.({} as any, { contactId }) as any

      expect(result.data[0].sourceRecordingTitle).toBe('Quarterly Planning')
      expect(db.getKnowledgeCaptureByRecordingId).toHaveBeenCalledWith(recordingId)
    })

    it('falls back to filename when no knowledge-capture title is present', async () => {
      const db = await import('../../services/database')
      vi.mocked(db.getVoiceprintsByContactId).mockReturnValue([makeMockVoiceprint()])
      vi.mocked(db.getRecordingById).mockReturnValue({ id: recordingId, filename: 'fallback.mp3' } as any)
      vi.mocked(db.getKnowledgeCaptureByRecordingId).mockReturnValue(undefined)

      const handler = getHandler()
      const result = await handler?.({} as any, { contactId }) as any

      expect(result.data[0].sourceRecordingTitle).toBe('fallback.mp3')
    })

    it('returns null sourceRecordingTitle when recording is missing', async () => {
      const db = await import('../../services/database')
      vi.mocked(db.getVoiceprintsByContactId).mockReturnValue([makeMockVoiceprint()])
      vi.mocked(db.getRecordingById).mockReturnValue(undefined)

      const handler = getHandler()
      const result = await handler?.({} as any, { contactId }) as any

      expect(result.data[0].sourceRecordingTitle).toBeNull()
      expect(db.getKnowledgeCaptureByRecordingId).not.toHaveBeenCalled()
    })

    it('returns null sourceRecordingTitle when voiceprint has no source recording', async () => {
      const db = await import('../../services/database')
      vi.mocked(db.getVoiceprintsByContactId).mockReturnValue([
        makeMockVoiceprint({ source_recording_id: null })
      ])

      const handler = getHandler()
      const result = await handler?.({} as any, { contactId }) as any

      expect(result.data[0].sourceRecordingId).toBeNull()
      expect(result.data[0].sourceRecordingTitle).toBeNull()
      expect(db.getRecordingById).not.toHaveBeenCalled()
      expect(db.getKnowledgeCaptureByRecordingId).not.toHaveBeenCalled()
    })

    it('returns VALIDATION_ERROR for a malformed contactId', async () => {
      const handler = getHandler()
      const result = await handler?.({} as any, { contactId: 'not-a-uuid' }) as any

      expect(result.success).toBe(false)
      expect(result.error.code).toBe('VALIDATION_ERROR')
    })

    it('returns DATABASE_ERROR when the database throws', async () => {
      const db = await import('../../services/database')
      vi.mocked(db.getVoiceprintsByContactId).mockImplementation(() => {
        throw new Error('db down')
      })

      const handler = getHandler()
      const result = await handler?.({} as any, { contactId }) as any

      expect(result.success).toBe(false)
      expect(result.error.code).toBe('DATABASE_ERROR')
    })
  })

  describe('voiceprints:disable', () => {
    function getHandler() {
      registerVoiceprintsHandlers()
      return vi.mocked(ipcMain.handle).mock.calls.find(c => c[0] === 'voiceprints:disable')?.[1]
    }

    it('calls disableVoiceprint with the parsed id and returns success', async () => {
      const db = await import('../../services/database')
      const handler = getHandler()
      const result = await handler?.({} as any, { id: voiceprintId }) as any

      expect(result.success).toBe(true)
      expect(db.disableVoiceprint).toHaveBeenCalledWith(voiceprintId)
    })

    it('returns VALIDATION_ERROR for a malformed id', async () => {
      const db = await import('../../services/database')
      const handler = getHandler()
      const result = await handler?.({} as any, { id: 'bad-id' }) as any

      expect(result.success).toBe(false)
      expect(result.error.code).toBe('VALIDATION_ERROR')
      expect(db.disableVoiceprint).not.toHaveBeenCalled()
    })

    it('returns DATABASE_ERROR when the database throws', async () => {
      const db = await import('../../services/database')
      vi.mocked(db.disableVoiceprint).mockImplementation(() => {
        throw new Error('db down')
      })

      const handler = getHandler()
      const result = await handler?.({} as any, { id: voiceprintId }) as any

      expect(result.success).toBe(false)
      expect(result.error.code).toBe('DATABASE_ERROR')
    })
  })

  describe('voiceprints:enable', () => {
    function getHandler() {
      registerVoiceprintsHandlers()
      return vi.mocked(ipcMain.handle).mock.calls.find(c => c[0] === 'voiceprints:enable')?.[1]
    }

    it('calls enableVoiceprint with the parsed id and returns success', async () => {
      const db = await import('../../services/database')
      const handler = getHandler()
      const result = await handler?.({} as any, { id: voiceprintId }) as any

      expect(result.success).toBe(true)
      expect(db.enableVoiceprint).toHaveBeenCalledWith(voiceprintId)
    })

    it('returns VALIDATION_ERROR for a malformed id', async () => {
      const db = await import('../../services/database')
      const handler = getHandler()
      const result = await handler?.({} as any, { id: 'bad-id' }) as any

      expect(result.success).toBe(false)
      expect(result.error.code).toBe('VALIDATION_ERROR')
      expect(db.enableVoiceprint).not.toHaveBeenCalled()
    })

    it('returns DATABASE_ERROR when the database throws', async () => {
      const db = await import('../../services/database')
      vi.mocked(db.enableVoiceprint).mockImplementation(() => {
        throw new Error('db down')
      })

      const handler = getHandler()
      const result = await handler?.({} as any, { id: voiceprintId }) as any

      expect(result.success).toBe(false)
      expect(result.error.code).toBe('DATABASE_ERROR')
    })
  })

  describe('voiceprints:delete', () => {
    function getHandler() {
      registerVoiceprintsHandlers()
      return vi.mocked(ipcMain.handle).mock.calls.find(c => c[0] === 'voiceprints:delete')?.[1]
    }

    it('calls deleteVoiceprint with the parsed id and returns success', async () => {
      const db = await import('../../services/database')
      const handler = getHandler()
      const result = await handler?.({} as any, { id: voiceprintId }) as any

      expect(result.success).toBe(true)
      expect(db.deleteVoiceprint).toHaveBeenCalledWith(voiceprintId)
    })

    it('returns VALIDATION_ERROR for a malformed id', async () => {
      const db = await import('../../services/database')
      const handler = getHandler()
      const result = await handler?.({} as any, { id: 'bad-id' }) as any

      expect(result.success).toBe(false)
      expect(result.error.code).toBe('VALIDATION_ERROR')
      expect(db.deleteVoiceprint).not.toHaveBeenCalled()
    })

    it('returns DATABASE_ERROR when the database throws', async () => {
      const db = await import('../../services/database')
      vi.mocked(db.deleteVoiceprint).mockImplementation(() => {
        throw new Error('db down')
      })

      const handler = getHandler()
      const result = await handler?.({} as any, { id: voiceprintId }) as any

      expect(result.success).toBe(false)
      expect(result.error.code).toBe('DATABASE_ERROR')
    })
  })

  describe('voiceprints:clearAllForContact', () => {
    function getHandler() {
      registerVoiceprintsHandlers()
      return vi.mocked(ipcMain.handle).mock.calls.find(c => c[0] === 'voiceprints:clearAllForContact')?.[1]
    }

    it('calls deleteVoiceprintsByContactId with the parsed contactId and returns deleted count', async () => {
      const db = await import('../../services/database')
      vi.mocked(db.deleteVoiceprintsByContactId).mockReturnValue(3)

      const handler = getHandler()
      const result = await handler?.({} as any, { contactId }) as any

      expect(result.success).toBe(true)
      expect(result.data).toEqual({ deleted: 3 })
      expect(db.deleteVoiceprintsByContactId).toHaveBeenCalledWith(contactId)
    })

    it('returns VALIDATION_ERROR for a malformed contactId', async () => {
      const db = await import('../../services/database')
      const handler = getHandler()
      const result = await handler?.({} as any, { contactId: 'bad-id' }) as any

      expect(result.success).toBe(false)
      expect(result.error.code).toBe('VALIDATION_ERROR')
      expect(db.deleteVoiceprintsByContactId).not.toHaveBeenCalled()
    })

    it('returns DATABASE_ERROR when the database throws', async () => {
      const db = await import('../../services/database')
      vi.mocked(db.deleteVoiceprintsByContactId).mockImplementation(() => {
        throw new Error('db down')
      })

      const handler = getHandler()
      const result = await handler?.({} as any, { contactId }) as any

      expect(result.success).toBe(false)
      expect(result.error.code).toBe('DATABASE_ERROR')
    })
  })

  describe('voiceprints:clearAll', () => {
    function getHandler() {
      registerVoiceprintsHandlers()
      return vi.mocked(ipcMain.handle).mock.calls.find(c => c[0] === 'voiceprints:clearAll')?.[1]
    }

    it('calls deleteAllVoiceprints and returns deleted count', async () => {
      const db = await import('../../services/database')
      vi.mocked(db.deleteAllVoiceprints).mockReturnValue(5)

      const handler = getHandler()
      const result = await handler?.({} as any) as any

      expect(result.success).toBe(true)
      expect(result.data).toEqual({ deleted: 5 })
      expect(db.deleteAllVoiceprints).toHaveBeenCalledTimes(1)
    })

    it('returns DATABASE_ERROR when the database throws', async () => {
      const db = await import('../../services/database')
      vi.mocked(db.deleteAllVoiceprints).mockImplementation(() => {
        throw new Error('db down')
      })

      const handler = getHandler()
      const result = await handler?.({} as any) as any

      expect(result.success).toBe(false)
      expect(result.error.code).toBe('DATABASE_ERROR')
    })
  })

  describe('voiceprints:findBySource', () => {
    function getHandler() {
      registerVoiceprintsHandlers()
      return vi.mocked(ipcMain.handle).mock.calls.find(c => c[0] === 'voiceprints:findBySource')?.[1]
    }

    it('returns a list scoped to contactId when provided', async () => {
      const db = await import('../../services/database')
      vi.mocked(db.getVoiceprintsBySource).mockReturnValue([makeMockVoiceprint()])
      vi.mocked(db.getRecordingById).mockReturnValue({ id: recordingId, filename: 'rec.mp3' } as any)
      vi.mocked(db.getKnowledgeCaptureByRecordingId).mockReturnValue(undefined)

      const handler = getHandler()
      const result = await handler?.({} as any, {
        recordingId,
        fileLabel: 'A',
        contactId
      }) as any

      expect(result.success).toBe(true)
      expect(result.data).toHaveLength(1)
      expect(db.getVoiceprintsBySource).toHaveBeenCalledWith(recordingId, 'A', contactId)
    })

    it('omits contactId from the database call when not provided', async () => {
      const db = await import('../../services/database')
      vi.mocked(db.getVoiceprintsBySource).mockReturnValue([])

      const handler = getHandler()
      const result = await handler?.({} as any, { recordingId, fileLabel: 'A' }) as any

      expect(result.success).toBe(true)
      expect(result.data).toEqual([])
      expect(db.getVoiceprintsBySource).toHaveBeenCalledWith(recordingId, 'A', undefined)
    })

    it('returns VALIDATION_ERROR for a malformed request', async () => {
      const db = await import('../../services/database')
      const handler = getHandler()
      const result = await handler?.({} as any, { recordingId: 'bad', fileLabel: '' }) as any

      expect(result.success).toBe(false)
      expect(result.error.code).toBe('VALIDATION_ERROR')
      expect(db.getVoiceprintsBySource).not.toHaveBeenCalled()
    })

    it('returns DATABASE_ERROR when the database throws', async () => {
      const db = await import('../../services/database')
      vi.mocked(db.getVoiceprintsBySource).mockImplementation(() => {
        throw new Error('db down')
      })

      const handler = getHandler()
      const result = await handler?.({} as any, { recordingId, fileLabel: 'A', contactId }) as any

      expect(result.success).toBe(false)
      expect(result.error.code).toBe('DATABASE_ERROR')
    })
  })
})
