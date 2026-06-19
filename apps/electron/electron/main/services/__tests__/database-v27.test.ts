/**
 * Schema v27 tests — voice-library foundation (spec 2026-06-19 rev 2 §8)
 *
 * Uses the REAL sql.js in-memory database (same pattern as database-v26.test.ts):
 * only external boundaries (electron, config, file-storage, vector-store) are mocked;
 * sql.js, fs, and database.ts run their real code.
 */
// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { vi } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'

// ---------------------------------------------------------------------------
// Hoisted shared state (real temp directory, resolves before vi.mock factories)
// ---------------------------------------------------------------------------
const shared = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _os = require('os') as typeof import('os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _fs = require('fs') as typeof import('fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _path = require('path') as typeof import('path')

  const tmpDir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'hidock-v27-'))
  const dataDir = _path.join(tmpDir, 'data')
  _fs.mkdirSync(dataDir, { recursive: true })

  return {
    tmpDir,
    dataDir,
    dbPath: _path.join(dataDir, 'hidock.db')
  }
})

// ---------------------------------------------------------------------------
// External-boundary mocks
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => os.tmpdir()),
    getName: vi.fn(() => 'test')
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() },
  Notification: { isSupported: vi.fn(() => false) }
}))

vi.mock('../config', () => ({
  getConfig: vi.fn(() => ({
    storage: { dataPath: shared.tmpDir, maxRecordingsGB: 50 },
    transcription: {
      provider: 'assemblyai',
      assemblyaiApiKey: 'test-key',
      assemblyaiModels: ['universal-3-pro', 'universal-2'],
      autoTranscribe: false
    }
  })),
  updateConfig: vi.fn(async () => {}),
  getDataPath: vi.fn(() => shared.tmpDir)
}))

vi.mock('../file-storage', () => ({
  getDatabasePath: vi.fn(() => shared.dbPath),
  getRecordingsPath: vi.fn(() => shared.tmpDir),
  getCachePath: vi.fn(() => os.tmpdir()),
  saveRecording: vi.fn(async (filename: string, _data: Buffer) => {
    return path.join(shared.tmpDir, filename)
  })
}))

vi.mock('../vector-store', () => ({
  getVectorStore: vi.fn(() => null)
}))

// ---------------------------------------------------------------------------
// Real service imports (resolved AFTER the mocks above)
// ---------------------------------------------------------------------------
import { initializeDatabase, closeDatabase, run, queryOne, queryAll } from '../database'
import {
  insertLabelEmbedding, getLabelEmbeddingsForRecording, deleteLabelEmbeddingsForRecording,
  insertSuggestion, dismissSuggestion, getPendingSuggestions,
  insertVoiceprint, getActiveVoiceprintsByContactId, deleteVoiceprint, disableVoiceprint,
  setSelfContact, getSelfContactId
} from '../database'

beforeEach(async () => {
  fs.mkdirSync(shared.dataDir, { recursive: true })
  if (fs.existsSync(shared.dbPath)) fs.rmSync(shared.dbPath)
  await initializeDatabase()
})
afterEach(() => { try { closeDatabase() } catch { /* ignore */ } })

describe('v27 voice-library foundation schema', () => {
  it('schema_version is 27', () => {
    expect(queryOne<{ version: number }>('SELECT MAX(version) AS version FROM schema_version')!.version).toBe(27)
  })
  it('recording_label_embeddings table exists with the expected columns', () => {
    run(`INSERT INTO recording_label_embeddings
      (id, recording_id, transcript_id, diarization_run_id, file_label, model_id, model_version, dim, embedding, clean_speech_ms, turn_count, quality_score, status, created_at)
      VALUES ('le1','r1','t1','run1','A','3dspeaker_eres2net_en_voxceleb',1,256,?,12000,5,0.9,'ok',?)`,
      [new Uint8Array(1024), new Date().toISOString()])
    expect(queryAll('SELECT * FROM recording_label_embeddings').length).toBe(1)
  })
  it('speaker_suggestions table exists', () => {
    run(`INSERT INTO speaker_suggestions (id, recording_id, transcript_id, kind, target_label, contact_id, score, rank, status, created_at)
         VALUES ('s1','r1','t1','identity','A','c1',0.7,0,'pending',?)`, [new Date().toISOString()])
    expect(queryAll("SELECT * FROM speaker_suggestions WHERE status='pending'").length).toBe(1)
  })
  it('voiceprints has provenance columns and accepts a disabled/superseded print', () => {
    run(`INSERT INTO contacts (id, name, first_seen_at, last_seen_at) VALUES ('c1','X',?,?)`, [new Date().toISOString(), new Date().toISOString()])
    run(`INSERT INTO voiceprints (id, contact_id, model_id, dim, embedding, created_at, source_recording_id, source_label, clean_speech_ms, quality_score, model_version, created_from)
         VALUES ('vp1','c1','3dspeaker_eres2net_en_voxceleb',256,?,?, 'r1','A',12000,0.9,1,'manual')`, [new Uint8Array(1024), new Date().toISOString()])
    run(`UPDATE voiceprints SET disabled_at=? WHERE id='vp1'`, [new Date().toISOString()])
    expect(queryOne<{ disabled_at: string }>("SELECT disabled_at FROM voiceprints WHERE id='vp1'")!.disabled_at).toBeTruthy()
  })
  it("recording_speakers.source now accepts 'confirmed' and 'self_auto' (CHECK rebuilt)", () => {
    expect(() => run(`INSERT INTO recording_speakers (recording_id, file_label, contact_id, source, created_at) VALUES ('r1','A','c1','confirmed',?)`, [new Date().toISOString()])).not.toThrow()
    expect(() => run(`INSERT INTO recording_speakers (recording_id, file_label, contact_id, source, created_at) VALUES ('r1','B','c1','self_auto',?)`, [new Date().toISOString()])).not.toThrow()
    expect(() => run(`INSERT INTO recording_speakers (recording_id, file_label, contact_id, source, created_at) VALUES ('r1','C','c1','robot',?)`, [new Date().toISOString()])).toThrow(/CHECK|constraint/i)
  })
  it('contacts has is_self', () => {
    run(`INSERT INTO contacts (id, name, is_self, first_seen_at, last_seen_at) VALUES ('me','Me',1,?,?)`, [new Date().toISOString(), new Date().toISOString()])
    expect(queryOne<{ is_self: number }>("SELECT is_self FROM contacts WHERE id='me'")!.is_self).toBe(1)
  })
})

describe('v27 DB helpers', () => {
  it('label embedding insert/get/delete round-trips', () => {
    insertLabelEmbedding({ id: 'le1', recording_id: 'r1', transcript_id: 't1', diarization_run_id: 'run1', file_label: 'A', model_id: 'm', model_version: 1, dim: 256, embedding: new Uint8Array(1024), clean_speech_ms: 12000, turn_count: 4, quality_score: 0.9, status: 'ok' })
    expect(getLabelEmbeddingsForRecording('r1')).toHaveLength(1)
    deleteLabelEmbeddingsForRecording('r1')
    expect(getLabelEmbeddingsForRecording('r1')).toHaveLength(0)
  })
  it('suggestions: insert, list pending, dismiss removes from pending', () => {
    insertSuggestion({ id: 's1', recording_id: 'r1', transcript_id: 't1', kind: 'identity', target_label: 'A', contact_id: 'c1', score: 0.7, rank: 0 })
    expect(getPendingSuggestions('r1')).toHaveLength(1)
    dismissSuggestion('s1')
    expect(getPendingSuggestions('r1')).toHaveLength(0)
  })
  it('voiceprint: active query excludes disabled; delete removes; disable hides', () => {
    run(`INSERT INTO contacts (id, name, first_seen_at, last_seen_at) VALUES ('c1','X',?,?)`, [new Date().toISOString(), new Date().toISOString()])
    insertVoiceprint({ id: 'vp1', contact_id: 'c1', model_id: 'm', dim: 256, embedding: new Uint8Array(1024) })
    insertVoiceprint({ id: 'vp2', contact_id: 'c1', model_id: 'm', dim: 256, embedding: new Uint8Array(1024) })
    expect(getActiveVoiceprintsByContactId('c1')).toHaveLength(2)
    disableVoiceprint('vp1')
    expect(getActiveVoiceprintsByContactId('c1')).toHaveLength(1)
    deleteVoiceprint('vp2')
    expect(getActiveVoiceprintsByContactId('c1')).toHaveLength(0)
  })
  it('self contact is a singleton', () => {
    run(`INSERT INTO contacts (id, name, first_seen_at, last_seen_at) VALUES ('a','A',?,?),('b','B',?,?)`, [new Date().toISOString(), new Date().toISOString(), new Date().toISOString(), new Date().toISOString()])
    setSelfContact('a'); expect(getSelfContactId()).toBe('a')
    setSelfContact('b'); expect(getSelfContactId()).toBe('b') // moves; only one self
    expect(queryAll('SELECT id FROM contacts WHERE is_self=1')).toHaveLength(1)
  })
})

describe('v27 upgrade path (v26 -> v27 migration)', () => {
  it('rebuilds voiceprints with the created_from CHECK and preserves existing rows', async () => {
    // simulate a v26-shape voiceprints: 6 columns, NO provenance, NO created_from CHECK
    run('DROP TABLE voiceprints')
    run(`CREATE TABLE voiceprints (id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, model_id TEXT NOT NULL,
         dim INTEGER NOT NULL, embedding BLOB NOT NULL, created_at TEXT NOT NULL)`)
    run(`INSERT INTO voiceprints (id, contact_id, model_id, dim, embedding, created_at)
         VALUES ('vpOld','c1','m',256,?,?)`, [new Uint8Array(8), new Date().toISOString()])
    // rewind the recorded schema version to 26 so re-init re-runs MIGRATIONS[27]
    run('DELETE FROM schema_version WHERE version >= 27')
    closeDatabase()
    await initializeDatabase() // runs MIGRATIONS[27] -> voiceprints rebuild

    expect(queryOne<{ id: string }>("SELECT id FROM voiceprints WHERE id='vpOld'")!.id).toBe('vpOld')
    expect(() => run(`INSERT INTO voiceprints (id, contact_id, model_id, dim, embedding, created_at, created_from)
         VALUES ('vpBad','c1','m',256,?,?, 'bogus')`, [new Uint8Array(8), new Date().toISOString()]))
      .toThrow(/CHECK|constraint/i)
    expect(() => run(`INSERT INTO voiceprints (id, contact_id, model_id, dim, embedding, created_at, created_from)
         VALUES ('vpOk','c1','m',256,?,?, 'confirmed')`, [new Uint8Array(8), new Date().toISOString()]))
      .not.toThrow()
  })
})
