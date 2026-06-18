import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerSpeakersHandlers } from '../speakers-handlers'
import { ipcMain } from 'electron'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() }
}))

vi.mock('../../services/database', () => ({
  upsertRecordingSpeaker: vi.fn(),
  getRecordingSpeakers: vi.fn(),
  getContactById: vi.fn()
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
