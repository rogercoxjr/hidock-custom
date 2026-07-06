import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as db from '../database'
import { isFileAlreadySynced } from '../sync-reconcile'

vi.mock('../database')
vi.mock('../file-storage', () => ({ getRecordingsPath: () => '/tmp/does-not-exist' }))

describe('isFileAlreadySynced', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns synced when the row is in synced_files', () => {
    vi.mocked(db.isFileSynced).mockReturnValue(true)
    expect(isFileAlreadySynced('REC001.hda')).toEqual({ synced: true, reason: 'In synced_files table' })
  })

  it('returns not-synced when nothing matches', () => {
    vi.mocked(db.isFileSynced).mockReturnValue(false)
    vi.mocked(db.getRecordingByFilename).mockReturnValue(undefined as any)
    expect(isFileAlreadySynced('NEW.hda').synced).toBe(false)
  })
})
