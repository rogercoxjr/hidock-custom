// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import os from 'os'
import fs from 'fs'

const shared = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _os = require('os') as typeof import('os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _fs = require('fs') as typeof import('fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _path = require('path') as typeof import('path')
  const tmpDir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'hidock-attrib-'))
  const dataDir = _path.join(tmpDir, 'data')
  _fs.mkdirSync(dataDir, { recursive: true })
  return { tmpDir, dataDir, dbPath: _path.join(dataDir, 'hidock.db') }
})

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), getName: vi.fn(() => 'test') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() },
  Notification: { isSupported: vi.fn(() => false) }
}))
vi.mock('../file-storage', () => ({
  getDatabasePath: vi.fn(() => shared.dbPath),
  getRecordingsPath: vi.fn(() => shared.dataDir),
  getCachePath: vi.fn(() => os.tmpdir())
}))

import {
  initializeDatabase,
  closeDatabase,
  run,
  upsertTranscriptStage1,
  buildAttributedTranscript
} from '../database'

function insertRecording(id: string): void {
  run(
    `INSERT OR IGNORE INTO recordings
       (id, filename, file_path, date_recorded, status, transcription_status,
        location, on_device, on_local, created_at)
     VALUES (?, ?, ?, ?, 'complete', 'complete', 'local-only', 0, 1, ?)`,
    [id, `${id}.hda`, `/tmp/${id}.hda`, new Date().toISOString(), new Date().toISOString()]
  )
}
function insertContact(id: string, name: string): void {
  const now = new Date().toISOString()
  run(
    `INSERT OR IGNORE INTO contacts (id, name, type, first_seen_at, last_seen_at, created_at)
     VALUES (?, ?, 'unknown', ?, ?, ?)`,
    [id, name, now, now, now]
  )
}

describe('buildAttributedTranscript (spec §6.6)', () => {
  beforeEach(async () => {
    if (fs.existsSync(shared.dbPath)) fs.rmSync(shared.dbPath)
    await initializeDatabase()
  })
  afterEach(() => { try { closeDatabase() } catch { /* ignore */ } })

  it('prefixes each turn with the mapped contact name when a recording_speakers row exists, else the file_label', async () => {
    insertRecording('rA')
    insertContact('cA', 'Alice')
    const turns = [
      { speaker: 'A', startMs: 0, endMs: 2000, text: 'Hello there' },
      { speaker: 'B', startMs: 2000, endMs: 4000, text: 'Hi back' },
      { speaker: 'A', startMs: 4000, endMs: 6000, text: 'How are you' }
    ]
    upsertTranscriptStage1({
      recording_id: 'rA',
      full_text: 'Hello there Hi back How are you',
      language: 'en',
      word_count: 7,
      transcription_provider: 'assemblyai',
      transcription_model: 'universal-3-pro'
    })
    run('UPDATE transcripts SET turns = ? WHERE recording_id = ?', [JSON.stringify(turns), 'rA'])
    // Map only label A -> Alice; B stays generic.
    run(
      `INSERT INTO recording_speakers (recording_id, file_label, contact_id, source, created_at)
       VALUES ('rA', 'A', 'cA', 'user', ?)`,
      [new Date().toISOString()]
    )

    const text = buildAttributedTranscript('rA')!
    expect(text).toBe('Alice: Hello there\nSpeaker B: Hi back\nAlice: How are you')
  })

  it('returns the flat full_text when turns is absent (Whisper/Gemini / pre-migration)', async () => {
    insertRecording('rB')
    upsertTranscriptStage1({
      recording_id: 'rB',
      full_text: 'flat transcript with no turns',
      language: 'en',
      word_count: 5,
      transcription_provider: 'gemini',
      transcription_model: 'gemini-2.0-flash'
    })
    const text = buildAttributedTranscript('rB')!
    expect(text).toBe('flat transcript with no turns')
  })

  it('returns the flat full_text when turns is an empty array (zero-speaker)', async () => {
    insertRecording('rC')
    upsertTranscriptStage1({
      recording_id: 'rC',
      full_text: 'music only no speech',
      language: 'en',
      word_count: 4,
      transcription_provider: 'assemblyai',
      transcription_model: 'universal-3-pro'
    })
    run('UPDATE transcripts SET turns = ? WHERE recording_id = ?', ['[]', 'rC'])
    const text = buildAttributedTranscript('rC')!
    expect(text).toBe('music only no speech')
  })
})

afterAll(() => {
  try { fs.rmSync(shared.tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
})
