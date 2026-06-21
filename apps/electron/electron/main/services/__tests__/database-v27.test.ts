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
  insertSuggestion, getPendingSuggestions, getSuggestionsForRecording,
  expireSuggestionsForRecording, acceptSuggestion, getContactsWithActiveVoiceprints,
  insertVoiceprint, getActiveVoiceprintsByContactId, deleteVoiceprint, disableVoiceprint,
  enableVoiceprint, deleteVoiceprintsByContactId, deleteAllVoiceprints,
  getVoiceprintsBySource, deleteVoiceprintsBySource,
  getRecordingSpeaker, setSelfContact, getSelfContactId, clearSelfContact,
  deleteContact
} from '../database'

beforeEach(async () => {
  fs.mkdirSync(shared.dataDir, { recursive: true })
  if (fs.existsSync(shared.dbPath)) fs.rmSync(shared.dbPath)
  await initializeDatabase()
})
afterEach(() => { try { closeDatabase() } catch { /* ignore */ } })

describe('v30 voice-library phase-2C schema', () => {
  it('schema_version is at current head (32)', () => {
    expect(queryOne<{ version: number }>('SELECT MAX(version) AS version FROM schema_version')!.version).toBe(32)
  })
  it('recording_label_embeddings table exists with the expected columns', () => {
    run(`INSERT INTO recording_label_embeddings
      (id, recording_id, transcript_id, diarization_run_id, file_label, model_id, model_version, dim, embedding, clean_speech_ms, turn_count, quality_score, status, created_at)
      VALUES ('le1','r1','t1','run1','A','3dspeaker_eres2net_en_voxceleb',1,256,?,12000,5,0.9,'ok',?)`,
      [new Uint8Array(1024), new Date().toISOString()])
    expect(queryAll('SELECT * FROM recording_label_embeddings').length).toBe(1)
  })
  it('speaker_suggestions table exists with diarization_run_id and contact_id_2', () => {
    const cols = queryAll<{ name: string }>("PRAGMA table_info(speaker_suggestions)").map(c => c.name)
    expect(cols).toContain('diarization_run_id')
    expect(cols).toContain('contact_id_2')
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
  it('suggestions: insert round-trips diarization_run_id and contact_id_2; pending/list/accept/expire work', () => {
    insertSuggestion({
      id: 's1', recording_id: 'r1', transcript_id: 't1', diarization_run_id: 'runA',
      kind: 'merge', target_label: 'A', target_label_2: 'B', contact_id: 'c1', contact_id_2: 'c2',
      score: 0.7, rank: 0
    })
    insertSuggestion({ id: 's2', recording_id: 'r1', transcript_id: 't1', diarization_run_id: 'runB', kind: 'identity', target_label: 'B', contact_id: 'c2', score: 0.6, rank: 1 })
    expect(getPendingSuggestions('r1')).toHaveLength(2)
    expect(getPendingSuggestions('r1', 'runA')).toHaveLength(1)
    expect(getPendingSuggestions('r1', 'runB')).toHaveLength(1)
    expect(getPendingSuggestions('r1', 'runC')).toHaveLength(0)
    expect(getSuggestionsForRecording('r1', 'runA')).toHaveLength(1)
    expect(getSuggestionsForRecording('r1', 'runB')).toHaveLength(1)
    expect(getSuggestionsForRecording('r1')).toHaveLength(2)

    const row = queryOne<{ diarization_run_id: string | null; contact_id_2: string | null }>("SELECT diarization_run_id, contact_id_2 FROM speaker_suggestions WHERE id='s1'")
    expect(row?.diarization_run_id).toBe('runA')
    expect(row?.contact_id_2).toBe('c2')

    acceptSuggestion('s1')
    expect(getPendingSuggestions('r1')).toHaveLength(1)
    expect(getPendingSuggestions('r1', 'runA')).toHaveLength(0)
    expect(queryOne<{ status: string }>("SELECT status FROM speaker_suggestions WHERE id='s1'")?.status).toBe('accepted')

    expireSuggestionsForRecording('r1')
    expect(getPendingSuggestions('r1')).toHaveLength(0)
    expect(queryOne<{ status: string }>("SELECT status FROM speaker_suggestions WHERE id='s2'")?.status).toBe('expired')
    expect(queryOne<{ status: string }>("SELECT status FROM speaker_suggestions WHERE id='s1'")?.status).toBe('expired')
  })
  it('getContactsWithActiveVoiceprints returns distinct contacts with active prints for a model', () => {
    const now = new Date().toISOString()
    run(`INSERT INTO contacts (id, name, first_seen_at, last_seen_at) VALUES ('c1','A',?,?),('c2','B',?,?),('c3','C',?,?)`, [now, now, now, now, now, now])
    insertVoiceprint({ id: 'vp1', contact_id: 'c1', model_id: 'mX', dim: 256, embedding: new Uint8Array(1024) })
    insertVoiceprint({ id: 'vp2', contact_id: 'c1', model_id: 'mX', dim: 256, embedding: new Uint8Array(1024) })
    insertVoiceprint({ id: 'vp3', contact_id: 'c2', model_id: 'mX', dim: 256, embedding: new Uint8Array(1024) })
    insertVoiceprint({ id: 'vp4', contact_id: 'c3', model_id: 'mY', dim: 256, embedding: new Uint8Array(1024) })
    disableVoiceprint('vp2')
    expect(getContactsWithActiveVoiceprints('mX').map(c => c.contact_id).sort()).toEqual(['c1', 'c2'])
    expect(getContactsWithActiveVoiceprints('mY').map(c => c.contact_id).sort()).toEqual(['c3'])
    expect(getContactsWithActiveVoiceprints('no-such-model')).toHaveLength(0)
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

describe('v27 Phase-2 hygiene helpers', () => {
  it('insertVoiceprint round-trips provenance fields', () => {
    run(`INSERT INTO contacts (id, name, first_seen_at, last_seen_at) VALUES ('c1','One',?,?)`, [new Date().toISOString(), new Date().toISOString()])
    insertVoiceprint({
      id: 'vp1', contact_id: 'c1', model_id: 'm', dim: 256, embedding: new Uint8Array(1024),
      source_recording_id: 'recA', source_label: 'L1', clean_speech_ms: 9000, quality_score: 0.85, model_version: 2, created_from: 'confirmed'
    })
    const row = queryOne<{ source_recording_id: string; source_label: string; clean_speech_ms: number; quality_score: number; model_version: number; created_from: string }>(
      `SELECT source_recording_id, source_label, clean_speech_ms, quality_score, model_version, created_from FROM voiceprints WHERE id='vp1'`
    )
    expect(row).toEqual({ source_recording_id: 'recA', source_label: 'L1', clean_speech_ms: 9000, quality_score: 0.85, model_version: 2, created_from: 'confirmed' })
  })

  it('enableVoiceprint clears disabled_at', () => {
    run(`INSERT INTO contacts (id, name, first_seen_at, last_seen_at) VALUES ('c1','One',?,?)`, [new Date().toISOString(), new Date().toISOString()])
    insertVoiceprint({ id: 'vp1', contact_id: 'c1', model_id: 'm', dim: 256, embedding: new Uint8Array(1024) })
    disableVoiceprint('vp1')
    expect(queryOne<{ disabled_at: string | null }>(`SELECT disabled_at FROM voiceprints WHERE id='vp1'`)!.disabled_at).toBeTruthy()
    enableVoiceprint('vp1')
    expect(queryOne<{ disabled_at: string | null }>(`SELECT disabled_at FROM voiceprints WHERE id='vp1'`)!.disabled_at).toBeNull()
  })

  it('getVoiceprintsBySource is contact-scoped and returns all when no contact filter', () => {
    const now = new Date().toISOString()
    run(`INSERT INTO contacts (id, name, first_seen_at, last_seen_at) VALUES ('cx','X',?,?),('cy','Y',?,?)`, [now, now, now, now])
    const blob = new Uint8Array(8)
    run(`INSERT INTO voiceprints (id, contact_id, model_id, dim, embedding, created_at, source_recording_id, source_label, created_from)
         VALUES ('vpx1','cx','m',256,?,?,?,'A','manual'),('vpx2','cx','m',256,?,?,?,'A','manual'),('vpy1','cy','m',256,?,?,?,'A','manual'),('vpx3','cx','m',256,?,?,?,'B','manual')`,
         [blob, now, 'rec1', blob, now, 'rec1', blob, now, 'rec1', blob, now, 'rec1'])

    expect(getVoiceprintsBySource('rec1', 'A', 'cx').map(v => v.id).sort()).toEqual(['vpx1', 'vpx2'])
    expect(getVoiceprintsBySource('rec1', 'A').map(v => v.id).sort()).toEqual(['vpx1', 'vpx2', 'vpy1'])
  })

  it('deleteVoiceprintsBySource removes only the scoped contact\'s prints', () => {
    const now = new Date().toISOString()
    run(`INSERT INTO contacts (id, name, first_seen_at, last_seen_at) VALUES ('cx','X',?,?),('cy','Y',?,?)`, [now, now, now, now])
    const blob = new Uint8Array(8)
    run(`INSERT INTO voiceprints (id, contact_id, model_id, dim, embedding, created_at, source_recording_id, source_label, created_from)
         VALUES ('vpx1','cx','m',256,?,?,?,'A','manual'),('vpx2','cx','m',256,?,?,?,'A','manual'),('vpy1','cy','m',256,?,?,?,'A','manual')`,
         [blob, now, 'rec1', blob, now, 'rec1', blob, now, 'rec1'])

    expect(deleteVoiceprintsBySource('rec1', 'A', 'cx')).toBe(2)
    expect(getVoiceprintsBySource('rec1', 'A', 'cx')).toHaveLength(0)
    expect(getVoiceprintsBySource('rec1', 'A', 'cy').map(v => v.id)).toEqual(['vpy1'])
  })

  it('deleteVoiceprintsByContactId deletes all prints for a contact and returns count', () => {
    const now = new Date().toISOString()
    run(`INSERT INTO contacts (id, name, first_seen_at, last_seen_at) VALUES ('cz','Z',?,?),('co','O',?,?)`, [now, now, now, now])
    const blob = new Uint8Array(8)
    run(`INSERT INTO voiceprints (id, contact_id, model_id, dim, embedding, created_at, source_recording_id, source_label, created_from)
         VALUES ('vpz1','cz','m',256,?,?,?,'A','manual'),('vpz2','cz','m',256,?,?,?,'A','manual'),('vpz3','cz','m',256,?,?,?,'B','manual'),('vpo1','co','m',256,?,?,?,'A','manual')`,
         [blob, now, 'rec1', blob, now, 'rec1', blob, now, 'rec2', blob, now, 'rec1'])

    expect(deleteVoiceprintsByContactId('cz')).toBe(3)
    expect(queryAll(`SELECT * FROM voiceprints WHERE contact_id='cz'`)).toHaveLength(0)
    expect(queryAll(`SELECT * FROM voiceprints WHERE contact_id='co'`)).toHaveLength(1)
  })

  it('deleteAllVoiceprints deletes all prints and returns count', () => {
    const now = new Date().toISOString()
    run(`INSERT INTO contacts (id, name, first_seen_at, last_seen_at) VALUES ('c1','One',?,?),('c2','Two',?,?)`, [now, now, now, now])
    const blob = new Uint8Array(8)
    run(`INSERT INTO voiceprints (id, contact_id, model_id, dim, embedding, created_at, source_recording_id, source_label, created_from)
         VALUES ('vp1','c1','m',256,?,?,?,'A','manual'),('vp2','c1','m',256,?,?,?,'B','manual'),('vp3','c2','m',256,?,?,?,'A','manual'),('vp4','c2','m',256,?,?,?,'B','manual')`,
         [blob, now, 'rec1', blob, now, 'rec1', blob, now, 'rec2', blob, now, 'rec2'])

    expect(deleteAllVoiceprints()).toBe(4)
    expect(queryAll('SELECT * FROM voiceprints')).toHaveLength(0)
  })

  it('getRecordingSpeaker returns the single matching row or undefined', () => {
    const now = new Date().toISOString()
    run(`INSERT INTO contacts (id, name, first_seen_at, last_seen_at) VALUES ('cx','X',?,?)`, [now, now])
    run(`INSERT INTO recording_speakers (recording_id, file_label, contact_id, source, created_at) VALUES ('rec1','A','cx','confirmed',?),('rec1','B','cx','self_auto',?)`, [now, now])

    const speaker = getRecordingSpeaker('rec1', 'A')
    expect(speaker).toMatchObject({ recording_id: 'rec1', file_label: 'A', contact_id: 'cx', source: 'confirmed' })
    expect(getRecordingSpeaker('rec1', 'Z')).toBeUndefined()
  })

  it('clearSelfContact sets all is_self=0', () => {
    const now = new Date().toISOString()
    run(`INSERT INTO contacts (id, name, is_self, first_seen_at, last_seen_at) VALUES ('a','A',1,?,?),('b','B',1,?,?)`, [now, now, now, now])
    clearSelfContact()
    expect(queryAll('SELECT * FROM contacts WHERE is_self=1')).toHaveLength(0)
    expect(queryAll('SELECT id FROM contacts WHERE is_self=0 ORDER BY id').map(r => (r as {id:string}).id)).toEqual(['a', 'b'])
  })

  it('deleteContact cascade removes voiceprints and recording_speakers atomically', () => {
    const now = new Date().toISOString()
    run(`INSERT INTO contacts (id, name, first_seen_at, last_seen_at) VALUES ('ckeep','Keep',?,?),('cdel','Delete',?,?)`, [now, now, now, now])
    run(`INSERT INTO meetings (id, subject, start_time, end_time, created_at, updated_at) VALUES ('m1','M','2026-01-01T00:00:00Z','2026-01-01T01:00:00Z',?,?)`, [now, now])
    run(`INSERT INTO meeting_contacts (meeting_id, contact_id, role) VALUES ('m1','cdel','attendee'),('m1','ckeep','attendee')`)
    const blob = new Uint8Array(8)
    run(`INSERT INTO voiceprints (id, contact_id, model_id, dim, embedding, created_at, source_recording_id, source_label, created_from)
         VALUES ('vpkeep','ckeep','m',256,?,?,?,'A','manual'),('vpdel','cdel','m',256,?,?,?,'A','manual')`, [blob, now, 'rec1', blob, now, 'rec1'])
    run(`INSERT INTO recording_speakers (recording_id, file_label, contact_id, source, created_at) VALUES ('rec1','A','cdel','confirmed',?),('rec1','B','ckeep','confirmed',?)`, [now, now])

    deleteContact('cdel')

    expect(queryOne(`SELECT id FROM contacts WHERE id='cdel'`)).toBeUndefined()
    expect(queryAll(`SELECT * FROM voiceprints WHERE contact_id='cdel'`)).toHaveLength(0)
    expect(queryAll(`SELECT * FROM voiceprints WHERE contact_id='ckeep'`)).toHaveLength(1)
    expect(getRecordingSpeaker('rec1', 'A')).toBeUndefined()
    expect(getRecordingSpeaker('rec1', 'B')).toBeDefined()
    expect(queryAll(`SELECT * FROM meeting_contacts WHERE contact_id='cdel'`)).toHaveLength(0)
    expect(queryAll(`SELECT * FROM meeting_contacts WHERE contact_id='ckeep'`)).toHaveLength(1)
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
