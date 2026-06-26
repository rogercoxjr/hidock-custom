/**
 * Schema v26 tests — speaker diarization (spec 2026-06-17 §6.3, AC1)
 *
 * Uses the REAL sql.js in-memory database (same pattern as database-v25.test.ts /
 * e2e-smoke.test.ts): only external boundaries (electron, config, file-storage,
 * vector-store) are mocked; sql.js, fs, and database.ts run their real code.
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

  const tmpDir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'hidock-v26-'))
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
import {
  initializeDatabase,
  closeDatabase,
  queryAll,
  queryOne,
  run,
  upsertTranscriptStage1,
  upsertRecordingSpeaker,
  getRecordingSpeakers,
  deleteRecordingSpeaker,
  deleteRecordingSpeakersForRecording,
  updateTranscriptTurns
} from '../database'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
function insertTestRecording(id: string): void {
  run(
    `INSERT OR IGNORE INTO recordings
       (id, filename, date_recorded, status, transcription_status, location, on_device, on_local)
     VALUES (?, ?, ?, 'pending', 'none', 'device-only', 1, 0)`,
    [id, `${id}.hda`, new Date().toISOString()]
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('schema v26 (speaker diarization)', () => {
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

  it('fresh boot has the transcripts.turns column', () => {
    const tCols = queryAll<{ name: string }>("SELECT name FROM pragma_table_info('transcripts')").map(c => c.name)
    expect(tCols).toContain('turns')
    // existing speakers/sentiment columns are still present (we reuse them)
    expect(tCols).toContain('speakers')
    expect(tCols).toContain('sentiment')
  })

  it('fresh boot has recording_speakers with the right PK + source CHECK', () => {
    const t = queryOne<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='recording_speakers'"
    )
    expect(t?.name).toBe('recording_speakers')
    const cols = queryAll<{ name: string; pk: number }>(
      "SELECT name, pk FROM pragma_table_info('recording_speakers')"
    )
    const colNames = cols.map(c => c.name)
    expect(colNames).toEqual(
      expect.arrayContaining(['recording_id', 'file_label', 'contact_id', 'confidence', 'source', 'created_at'])
    )
    // composite PK is (recording_id, file_label)
    const pkCols = cols.filter(c => c.pk > 0).map(c => c.name).sort()
    expect(pkCols).toEqual(['file_label', 'recording_id'])
  })

  it("recording_speakers rejects a source outside ('user','auto')", () => {
    insertTestRecording('rec_chk')
    expect(() =>
      run(
        `INSERT INTO recording_speakers (recording_id, file_label, source, created_at)
         VALUES ('rec_chk', 'A', 'robot', ?)`,
        [new Date().toISOString()]
      )
    ).toThrow(/CHECK constraint|constraint failed/i)
  })

  it('fresh boot has voiceprints with model_id/dim/embedding BLOB', () => {
    const t = queryOne<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='voiceprints'"
    )
    expect(t?.name).toBe('voiceprints')
    const cols = queryAll<{ name: string; type: string }>(
      "SELECT name, type FROM pragma_table_info('voiceprints')"
    )
    const byName = Object.fromEntries(cols.map(c => [c.name, c.type]))
    expect(Object.keys(byName)).toEqual(
      expect.arrayContaining(['id', 'contact_id', 'model_id', 'dim', 'embedding', 'created_at'])
    )
    expect(byName['embedding']).toMatch(/BLOB/i)
    expect(byName['dim']).toMatch(/INTEGER/i)
  })

  it('upgrade path: a v25 DB gains turns + recording_speakers + voiceprints after re-init', async () => {
    // Rewind the recorded version to 25, then re-init the SAME db file so the REAL
    // MIGRATIONS[26] runs (no hand-copied SQL that could drift from the migration).
    run('DELETE FROM schema_version')
    run('INSERT INTO schema_version (version) VALUES (25)')
    closeDatabase()
    await initializeDatabase()

    const tCols = queryAll<{ name: string }>("SELECT name FROM pragma_table_info('transcripts')").map(c => c.name)
    expect(tCols).toContain('turns')
    expect(
      queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='recording_speakers'")
    ).toBeTruthy()
    expect(
      queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='voiceprints'")
    ).toBeTruthy()
    const ver = queryOne<{ version: number }>('SELECT MAX(version) AS version FROM schema_version')
    expect(ver?.version).toBe(34) // re-init migrates v25 forward to the current head (v34)
  })
})

// ---------------------------------------------------------------------------
// D2-T2: upsertTranscriptStage1 turns/speakers/sentiment persistence (AC1)
// ---------------------------------------------------------------------------

describe('upsertTranscriptStage1 — turns/speakers/sentiment (spec §6.3, AC1)', () => {
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

  it('writes turns JSON, a distinct speakers roster, and a dominant-sentiment roster summary', () => {
    insertTestRecording('rec_aa')
    upsertTranscriptStage1({
      recording_id: 'rec_aa',
      full_text: 'Hi there. Yes hello. Good to see you.',
      language: 'en',
      word_count: 8,
      transcription_provider: 'assemblyai',
      transcription_model: 'universal-3-pro',
      turns: [
        { speaker: 'A', startMs: 0, endMs: 1000, text: 'Hi there.', sentiment: 'POSITIVE' },
        { speaker: 'B', startMs: 1000, endMs: 2000, text: 'Yes hello.', sentiment: 'NEUTRAL' },
        // A has two turns; POSITIVE is the majority -> dominant POSITIVE
        { speaker: 'A', startMs: 2000, endMs: 3000, text: 'Good to see you.', sentiment: 'POSITIVE' }
      ]
    })

    const row = queryOne<{ turns: string; speakers: string; sentiment: string }>(
      "SELECT turns, speakers, sentiment FROM transcripts WHERE recording_id='rec_aa'"
    )
    expect(row).toBeDefined()

    const turns = JSON.parse(row!.turns)
    expect(turns).toHaveLength(3)
    expect(turns[0]).toMatchObject({ speaker: 'A', startMs: 0, endMs: 1000, text: 'Hi there.', sentiment: 'POSITIVE' })

    const speakers = JSON.parse(row!.speakers)
    expect(speakers).toEqual(['A', 'B']) // distinct roster, first-seen order

    const sentiment = JSON.parse(row!.sentiment)
    expect(sentiment).toEqual({ A: 'POSITIVE', B: 'NEUTRAL' }) // dominant per label
  })

  it('writes empty roster + {} sentiment when turns carry no sentiment field', () => {
    insertTestRecording('rec_bb')
    upsertTranscriptStage1({
      recording_id: 'rec_bb',
      full_text: 'one two three',
      language: 'en',
      word_count: 3,
      transcription_provider: 'assemblyai',
      transcription_model: 'universal-3-pro',
      turns: [
        { speaker: 'A', startMs: 0, endMs: 500, text: 'one two' },
        { speaker: 'B', startMs: 500, endMs: 1000, text: 'three' }
      ]
    })
    const row = queryOne<{ speakers: string; sentiment: string }>(
      "SELECT speakers, sentiment FROM transcripts WHERE recording_id='rec_bb'"
    )
    expect(JSON.parse(row!.speakers)).toEqual(['A', 'B'])
    expect(JSON.parse(row!.sentiment)).toEqual({}) // no per-turn sentiment -> empty summary
  })

  it('breaks a sentiment tie deterministically: POSITIVE > NEUTRAL > NEGATIVE precedence', () => {
    insertTestRecording('rec_tie')
    upsertTranscriptStage1({
      recording_id: 'rec_tie',
      full_text: 'a b',
      transcription_provider: 'assemblyai',
      turns: [
        { speaker: 'A', startMs: 0, endMs: 1, text: 'a', sentiment: 'POSITIVE' },
        { speaker: 'A', startMs: 1, endMs: 2, text: 'b', sentiment: 'NEGATIVE' }
      ]
    })
    const row = queryOne<{ sentiment: string }>(
      "SELECT sentiment FROM transcripts WHERE recording_id='rec_tie'"
    )
    // 1 POSITIVE vs 1 NEGATIVE -> POSITIVE wins (POSITIVE > NEUTRAL > NEGATIVE precedence)
    expect(JSON.parse(row!.sentiment)).toEqual({ A: 'POSITIVE' })
  })

  it('breaks a sentiment tie deterministically: precedence holds regardless of turn order', () => {
    insertTestRecording('rec_tie_order')
    upsertTranscriptStage1({
      recording_id: 'rec_tie_order',
      full_text: 'a b',
      transcription_provider: 'assemblyai',
      turns: [
        { speaker: 'A', startMs: 0, endMs: 1, text: 'a', sentiment: 'NEGATIVE' },
        { speaker: 'A', startMs: 1, endMs: 2, text: 'b', sentiment: 'POSITIVE' }
      ]
    })
    const row = queryOne<{ sentiment: string }>(
      "SELECT sentiment FROM transcripts WHERE recording_id='rec_tie_order'"
    )
    // NEGATIVE appears FIRST but POSITIVE still wins -> order-independent precedence
    expect(JSON.parse(row!.sentiment)).toEqual({ A: 'POSITIVE' })
  })

  it('REGRESSION: a provider with no turns leaves turns/speakers/sentiment NULL (Whisper/Gemini path)', () => {
    insertTestRecording('rec_legacy')
    upsertTranscriptStage1({
      recording_id: 'rec_legacy',
      full_text: 'plain whisper transcript',
      language: 'en',
      word_count: 3,
      transcription_provider: 'openai-whisper',
      transcription_model: 'whisper-1'
      // no turns
    })
    const row = queryOne<{ turns: string | null; speakers: string | null; sentiment: string | null }>(
      "SELECT turns, speakers, sentiment FROM transcripts WHERE recording_id='rec_legacy'"
    )
    expect(row!.turns).toBeNull()
    expect(row!.speakers).toBeNull()
    expect(row!.sentiment).toBeNull()
  })

  it('never clobbers Stage-2 columns on a Stage-1 re-run with turns', () => {
    insertTestRecording('rec_s2safe')
    upsertTranscriptStage1({
      recording_id: 'rec_s2safe',
      full_text: 'v1',
      transcription_provider: 'assemblyai',
      turns: [{ speaker: 'A', startMs: 0, endMs: 1, text: 'v1' }]
    })
    // Simulate Stage 2 having completed:
    run(`UPDATE transcripts SET summary='S', summarization_provider='ollama-cloud' WHERE recording_id='rec_s2safe'`)
    // Re-run Stage 1 (e.g. re-transcribe) with different turns:
    upsertTranscriptStage1({
      recording_id: 'rec_s2safe',
      full_text: 'v2',
      transcription_provider: 'assemblyai',
      turns: [
        { speaker: 'A', startMs: 0, endMs: 1, text: 'v2a' },
        { speaker: 'B', startMs: 1, endMs: 2, text: 'v2b' }
      ]
    })
    const row = queryOne<{ full_text: string; summary: string; summarization_provider: string; speakers: string }>(
      "SELECT full_text, summary, summarization_provider, speakers FROM transcripts WHERE recording_id='rec_s2safe'"
    )
    expect(row!.full_text).toBe('v2')                         // Stage-1 columns updated
    expect(JSON.parse(row!.speakers)).toEqual(['A', 'B'])     // roster recomputed
    expect(row!.summary).toBe('S')                            // Stage-2 untouched
    expect(row!.summarization_provider).toBe('ollama-cloud')  // marker untouched
  })
})

// ---------------------------------------------------------------------------
// D2-T3: recording_speakers CRUD helpers (powers D3/D4)
// ---------------------------------------------------------------------------

describe('recording_speakers helpers (spec §6.3)', () => {
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

  it('upsertRecordingSpeaker inserts a row with default source=user and is read back by getRecordingSpeakers', () => {
    insertTestRecording('rec_rs1')
    upsertRecordingSpeaker({ recording_id: 'rec_rs1', file_label: 'A', contact_id: 'c1' })
    const rows = getRecordingSpeakers('rec_rs1')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ recording_id: 'rec_rs1', file_label: 'A', contact_id: 'c1', source: 'user' })
    expect(rows[0].created_at).toBeTruthy()
  })

  it('upsertRecordingSpeaker updates contact_id/confidence on the (recording_id,file_label) PK conflict', () => {
    insertTestRecording('rec_rs2')
    upsertRecordingSpeaker({ recording_id: 'rec_rs2', file_label: 'A', contact_id: 'c1' })
    upsertRecordingSpeaker({ recording_id: 'rec_rs2', file_label: 'A', contact_id: 'c2', confidence: 0.9 })
    const rows = getRecordingSpeakers('rec_rs2')
    expect(rows).toHaveLength(1) // no duplicate — PK conflict updated in place
    expect(rows[0].contact_id).toBe('c2')
    expect(rows[0].confidence).toBe(0.9)
  })

  it('deleteRecordingSpeaker removes exactly one label (merge support, §6.3)', () => {
    insertTestRecording('rec_rs3')
    upsertRecordingSpeaker({ recording_id: 'rec_rs3', file_label: 'A', contact_id: 'c1' })
    upsertRecordingSpeaker({ recording_id: 'rec_rs3', file_label: 'C', contact_id: 'c3' })
    deleteRecordingSpeaker('rec_rs3', 'C')
    const rows = getRecordingSpeakers('rec_rs3')
    expect(rows.map(r => r.file_label)).toEqual(['A'])
  })

  it('deleteRecordingSpeakersForRecording clears all labels for the recording (re-transcribe, §6.3/§6.8)', () => {
    insertTestRecording('rec_rs4')
    upsertRecordingSpeaker({ recording_id: 'rec_rs4', file_label: 'A', contact_id: 'c1' })
    upsertRecordingSpeaker({ recording_id: 'rec_rs4', file_label: 'B', contact_id: 'c2' })
    const removed = deleteRecordingSpeakersForRecording('rec_rs4')
    expect(removed).toBe(2)
    expect(getRecordingSpeakers('rec_rs4')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// D3-T3 (fix): updateTranscriptTurns — persist merge/reassign turn edits (§6.3)
// ---------------------------------------------------------------------------

describe('updateTranscriptTurns — persist edited turns (spec §6.3, AC3)', () => {
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

  it('writes the JSON-serialized turns array to transcripts.turns for the recording', () => {
    insertTestRecording('rec_upd')
    upsertTranscriptStage1({
      recording_id: 'rec_upd',
      full_text: 'a b',
      transcription_provider: 'assemblyai',
      turns: [
        { speaker: 'A', startMs: 0, endMs: 1000, text: 'a' },
        { speaker: 'C', startMs: 1000, endMs: 2000, text: 'c' }
      ]
    })

    // Rewrite C -> A (merge) and persist.
    updateTranscriptTurns('rec_upd', [
      { speaker: 'A', startMs: 0, endMs: 1000, text: 'a' },
      { speaker: 'A', startMs: 1000, endMs: 2000, text: 'c' }
    ])

    const row = queryOne<{ turns: string }>("SELECT turns FROM transcripts WHERE recording_id='rec_upd'")
    const turns = JSON.parse(row!.turns)
    expect(turns).toHaveLength(2)
    expect(turns.map((t: { speaker: string }) => t.speaker)).toEqual(['A', 'A'])
  })

  it('does not touch Stage-2 columns (summary / summarization_provider)', () => {
    insertTestRecording('rec_upd2')
    upsertTranscriptStage1({
      recording_id: 'rec_upd2',
      full_text: 'v1',
      transcription_provider: 'assemblyai',
      turns: [{ speaker: 'A', startMs: 0, endMs: 1, text: 'v1' }]
    })
    run(`UPDATE transcripts SET summary='S', summarization_provider='ollama-cloud' WHERE recording_id='rec_upd2'`)

    updateTranscriptTurns('rec_upd2', [{ speaker: 'B', startMs: 0, endMs: 1, text: 'v1' }])

    const row = queryOne<{ turns: string; summary: string; summarization_provider: string }>(
      "SELECT turns, summary, summarization_provider FROM transcripts WHERE recording_id='rec_upd2'"
    )
    expect(JSON.parse(row!.turns)[0].speaker).toBe('B')
    expect(row!.summary).toBe('S')
    expect(row!.summarization_provider).toBe('ollama-cloud')
  })
})
