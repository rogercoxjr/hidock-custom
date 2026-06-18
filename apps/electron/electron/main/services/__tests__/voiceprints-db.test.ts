/**
 * voiceprints DB round-trip — speaker-diarization D4 (spec §6.3, AC4).
 *
 * Uses the REAL sql.js in-memory database (same pattern as database-v25.test.ts):
 * only external boundaries (electron, config, file-storage, vector-store) are
 * mocked; sql.js, fs, and database.ts run their real implementations.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'

const shared = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _os = require('os') as typeof import('os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _fs = require('fs') as typeof import('fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _path = require('path') as typeof import('path')
  const tmpDir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'hidock-vp-'))
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
vi.mock('../config', () => ({
  getConfig: vi.fn(() => ({
    storage: { dataPath: shared.tmpDir, maxRecordingsGB: 50 },
    transcription: { provider: 'assemblyai', autoTranscribe: false }
  })),
  updateConfig: vi.fn(async () => {}),
  getDataPath: vi.fn(() => shared.tmpDir)
}))
vi.mock('../file-storage', () => ({
  getDatabasePath: vi.fn(() => shared.dbPath),
  getRecordingsPath: vi.fn(() => shared.tmpDir),
  getCachePath: vi.fn(() => os.tmpdir()),
  saveRecording: vi.fn(async (filename: string, _data: Buffer) => path.join(shared.tmpDir, filename))
}))
vi.mock('../vector-store', () => ({ initVectorStore: vi.fn(async () => {}) }))

import { initializeDatabase, closeDatabase, insertVoiceprint, getVoiceprintsByContactId } from '../database'

beforeEach(async () => {
  fs.mkdirSync(shared.dataDir, { recursive: true })
  if (fs.existsSync(shared.dbPath)) fs.rmSync(shared.dbPath)
  await initializeDatabase()
})
afterEach(() => {
  try {
    closeDatabase()
  } catch {
    /* ignore */
  }
})

describe('voiceprints insert/read (§6.3, AC4)', () => {
  it('1. round-trips a BLOB embedding with model_id and dim', () => {
    const emb = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    insertVoiceprint({
      id: 'vp_1',
      contact_id: 'c_1',
      model_id: 'wespeaker_en_voxceleb_resnet34_LM',
      dim: 256,
      embedding: emb
    })
    const rows = getVoiceprintsByContactId('c_1')
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('vp_1')
    expect(rows[0].model_id).toBe('wespeaker_en_voxceleb_resnet34_LM')
    expect(rows[0].dim).toBe(256)
    expect(Array.from(rows[0].embedding)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(typeof rows[0].created_at).toBe('string')
  })

  it('2. allows multiple voiceprints per contact', () => {
    insertVoiceprint({ id: 'vp_a', contact_id: 'c_2', model_id: 'm', dim: 4, embedding: new Uint8Array([1]) })
    insertVoiceprint({ id: 'vp_b', contact_id: 'c_2', model_id: 'm', dim: 4, embedding: new Uint8Array([2]) })
    expect(getVoiceprintsByContactId('c_2')).toHaveLength(2)
  })

  it('3. returns empty array for a contact with no voiceprints', () => {
    const rows = getVoiceprintsByContactId('no_such_contact')
    expect(rows).toHaveLength(0)
  })
})
