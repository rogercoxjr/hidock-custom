/**
 * speakers:assign → voiceprint capture wiring — D4 (§6.7, AC4).
 *
 * Asserts the handler fires captureVoiceprint after writing the
 * recording_speakers row, and that a capture failure never fails the IPC.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn)) },
  app: { getPath: vi.fn(() => '/tmp/hidock') },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false), encryptString: vi.fn(), decryptString: vi.fn() }
}))
vi.mock('../../services/voiceprint-service', () => ({
  captureVoiceprint: vi.fn(async () => ({ captured: true }))
}))
// D3's recording_speakers writer + any contact lookups the handler uses:
vi.mock('../../services/database', () => ({
  upsertRecordingSpeaker: vi.fn(),
  getRecordingSpeaker: vi.fn(),
  getContactById: vi.fn(() => ({ id: 'c_1', name: 'Alice' })),
  getRecordingSpeakers: vi.fn(),
  deleteRecordingSpeaker: vi.fn(),
  deleteVoiceprintsBySource: vi.fn(),
  getTranscriptByRecordingId: vi.fn(),
  updateTranscriptTurns: vi.fn()
}))

import { registerSpeakersHandlers } from '../speakers-handlers'
import { captureVoiceprint } from '../../services/voiceprint-service'
import { upsertRecordingSpeaker } from '../../services/database'

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  registerSpeakersHandlers()
})

describe('speakers:assign → voiceprint capture (§6.7)', () => {
  it('1. invokes captureVoiceprint(recordingId, fileLabel, contactId) after assign', async () => {
    const fn = handlers.get('speakers:assign')!
    await fn({}, { recordingId: 'rec_1', fileLabel: 'A', contactId: 'c_1' })
    await new Promise((r) => setImmediate(r)) // capture is deferred to a later tick
    expect(vi.mocked(captureVoiceprint)).toHaveBeenCalledWith('rec_1', 'A', 'c_1', 'manual')
  })

  it('6. defers capture to a later tick — not run on the synchronous assign IPC path', async () => {
    const fn = handlers.get('speakers:assign')!
    await fn({}, { recordingId: 'rec_1', fileLabel: 'A', contactId: 'c_1' })
    // The IPC has returned but capture must NOT have run yet (it would block the
    // main thread; it is scheduled for a later tick).
    expect(vi.mocked(captureVoiceprint)).not.toHaveBeenCalled()
    await new Promise((r) => setImmediate(r)) // let the deferred capture fire
    expect(vi.mocked(captureVoiceprint)).toHaveBeenCalledWith('rec_1', 'A', 'c_1', 'manual')
  })

  it('2. capture failure does not fail the assignment IPC', async () => {
    vi.mocked(captureVoiceprint).mockRejectedValueOnce(new Error('boom'))
    const fn = handlers.get('speakers:assign')!
    const res = (await fn({}, { recordingId: 'rec_1', fileLabel: 'A', contactId: 'c_1' })) as { success: boolean }
    expect(res.success).toBe(true)
  })

  it('3. upsertRecordingSpeaker is called before captureVoiceprint', async () => {
    const callOrder: string[] = []
    vi.mocked(upsertRecordingSpeaker).mockImplementation(() => { callOrder.push('upsert'); return undefined as any })
    vi.mocked(captureVoiceprint).mockImplementation(async () => { callOrder.push('capture'); return { captured: true } })

    const fn = handlers.get('speakers:assign')!
    const res = (await fn({}, { recordingId: 'rec_1', fileLabel: 'A', contactId: 'c_1' })) as { success: boolean }
    await new Promise((r) => setImmediate(r)) // capture is deferred to a later tick

    expect(res.success).toBe(true)
    expect(callOrder.indexOf('upsert')).toBeLessThan(callOrder.indexOf('capture'))
  })

  it('4. NOT_FOUND for unknown contact (existing regression)', async () => {
    const { getContactById } = await import('../../services/database')
    vi.mocked(getContactById).mockReturnValueOnce(undefined as any)

    const fn = handlers.get('speakers:assign')!
    const res = (await fn({}, { recordingId: 'rec_1', fileLabel: 'A', contactId: 'missing' })) as any

    expect(res.success).toBe(false)
    expect(res.error.code).toBe('NOT_FOUND')
    expect(vi.mocked(captureVoiceprint)).not.toHaveBeenCalled()
  })

  it('5. VALIDATION_ERROR for blank fileLabel (existing regression)', async () => {
    const fn = handlers.get('speakers:assign')!
    const res = (await fn({}, { recordingId: 'rec_1', fileLabel: '', contactId: 'c_1' })) as any

    expect(res.success).toBe(false)
    expect(res.error.code).toBe('VALIDATION_ERROR')
    expect(vi.mocked(captureVoiceprint)).not.toHaveBeenCalled()
  })
})
