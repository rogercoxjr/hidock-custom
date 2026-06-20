import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerDiarizationHandlers } from '../diarization-handlers'
import { ipcMain } from 'electron'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() }
}))

const mockGetLatest = vi.fn()
const mockGetRuns = vi.fn()

vi.mock('../../services/database', () => ({
  getLatestDiarizationRun: (...args: any[]) => mockGetLatest(...args),
  getDiarizationRunsForRecording: (...args: any[]) => mockGetRuns(...args)
}))

const recordingId = 'rec-770e8400-e29b-41d4-a716-446655440000'

function makeMockRun(overrides: Partial<any> = {}): any {
  return {
    id: 'diar_1',
    recording_id: recordingId,
    transcript_id: 'trans_1',
    provider: 'assemblyai',
    model: 'universal-3-pro',
    options_min: 1,
    options_max: 8,
    options_sent_json: '{"min_speakers_expected":1,"max_speakers_expected":8}',
    label_count: 2,
    is_solo: 0,
    solo_reason: null,
    failure_reason: null,
    duration_ms: 180000,
    policy_version: 1,
    created_at: '2026-06-19T00:00:00.000Z',
    ...overrides
  }
}

describe('Diarization IPC Handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('registers the expected channels', () => {
    registerDiarizationHandlers()
    expect(ipcMain.handle).toHaveBeenCalledWith('diarization:getLatestRun', expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith('diarization:getRunsForRecording', expect.any(Function))
  })

  describe('diarization:getLatestRun', () => {
    function getHandler() {
      registerDiarizationHandlers()
      return vi.mocked(ipcMain.handle).mock.calls.find((c) => c[0] === 'diarization:getLatestRun')?.[1]
    }

    it('returns the latest run wrapped in a success result', async () => {
      mockGetLatest.mockReturnValue(makeMockRun())

      const handler = getHandler()
      const result = await handler?.({} as any, recordingId)

      expect(result?.success).toBe(true)
      expect(result?.data?.id).toBe('diar_1')
      expect(mockGetLatest).toHaveBeenCalledWith(recordingId)
    })

    it('returns null when no run exists', async () => {
      mockGetLatest.mockReturnValue(undefined)

      const handler = getHandler()
      const result = await handler?.({} as any, recordingId)

      expect(result?.success).toBe(true)
      expect(result?.data).toBeNull()
    })

    it('returns VALIDATION_ERROR for an empty recordingId', async () => {
      const handler = getHandler()
      const result = await handler?.({} as any, '')

      expect(result?.success).toBe(false)
      expect(result?.error?.code).toBe('VALIDATION_ERROR')
      expect(mockGetLatest).not.toHaveBeenCalled()
    })

    it('returns DATABASE_ERROR when the database throws', async () => {
      mockGetLatest.mockImplementation(() => {
        throw new Error('db down')
      })

      const handler = getHandler()
      const result = await handler?.({} as any, recordingId)

      expect(result?.success).toBe(false)
      expect(result?.error?.code).toBe('DATABASE_ERROR')
    })
  })

  describe('diarization:getRunsForRecording', () => {
    function getHandler() {
      registerDiarizationHandlers()
      return vi.mocked(ipcMain.handle).mock.calls.find((c) => c[0] === 'diarization:getRunsForRecording')?.[1]
    }

    it('returns all runs newest-first wrapped in a success result', async () => {
      mockGetRuns.mockReturnValue([makeMockRun({ id: 'diar_2' }), makeMockRun({ id: 'diar_1' })])

      const handler = getHandler()
      const result = await handler?.({} as any, recordingId)

      expect(result?.success).toBe(true)
      expect(result?.data).toHaveLength(2)
      expect(result?.data[0].id).toBe('diar_2')
      expect(mockGetRuns).toHaveBeenCalledWith(recordingId)
    })

    it('returns VALIDATION_ERROR for an empty recordingId', async () => {
      const handler = getHandler()
      const result = await handler?.({} as any, '')

      expect(result?.success).toBe(false)
      expect(result?.error?.code).toBe('VALIDATION_ERROR')
      expect(mockGetRuns).not.toHaveBeenCalled()
    })

    it('returns DATABASE_ERROR when the database throws', async () => {
      mockGetRuns.mockImplementation(() => {
        throw new Error('db down')
      })

      const handler = getHandler()
      const result = await handler?.({} as any, recordingId)

      expect(result?.success).toBe(false)
      expect(result?.error?.code).toBe('DATABASE_ERROR')
    })
  })
})
