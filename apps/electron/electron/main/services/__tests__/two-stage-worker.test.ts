/**
 * Two-stage worker tests — auto-pipeline P1 (spec 2026-06-11 §5.3).
 *
 * Uses the REAL sql.js in-memory database (same boundary-mock pattern as
 * e2e-smoke.test.ts / database-v25.test.ts) so the worker's actual Stage-1
 * upsert, Stage-2 marker UPDATE, auto-rename predicate, and actionables
 * delete-and-replace run against real schema. Only external boundaries are
 * mocked: electron, config, file-storage, vector-store, and the Gemini SDK.
 *
 * The Gemini mock (newable-class idiom from providers-p1.test.ts) routes on the
 * argument shape: an ARRAY arg = the audio (ASR) call, a STRING arg = a text
 * (analysis / actionables) call. Per-test queues let each case decide what each
 * call returns, and counters prove which stages ran (short-circuit / resume).
 */
// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'

// ---------------------------------------------------------------------------
// Hoisted shared state — real temp dir + the Gemini call router/counters.
// Resolves before the vi.mock factories below.
// ---------------------------------------------------------------------------
const shared = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _os = require('os') as typeof import('os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _fs = require('fs') as typeof import('fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _path = require('path') as typeof import('path')

  const tmpDir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'hidock-2stage-'))
  const dataDir = _path.join(tmpDir, 'data')
  const recordingsDir = _path.join(tmpDir, 'recordings')
  _fs.mkdirSync(dataDir, { recursive: true })
  _fs.mkdirSync(recordingsDir, { recursive: true })

  return {
    tmpDir,
    dataDir,
    recordingsDir,
    dbPath: _path.join(dataDir, 'hidock.db'),
    // Mutable per-test routing: the NEXT text response and the audio response.
    // textResponses is a FIFO queue: first text call -> analysis, then actionables.
    audioResponse: 'FULL TEXT' as string,
    textResponses: [] as string[],
    audioCalls: 0,
    textCalls: 0
  }
})

// ---------------------------------------------------------------------------
// External-boundary mocks (hoisted before the real imports).
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
      provider: 'gemini',
      geminiApiKey: 'test-key',
      geminiModel: 'gemini-2.0-flash',
      autoTranscribe: false
    }
  })),
  updateConfig: vi.fn(async () => {}),
  getDataPath: vi.fn(() => shared.tmpDir)
}))

vi.mock('../file-storage', () => ({
  getDatabasePath: vi.fn(() => shared.dbPath),
  getRecordingsPath: vi.fn(() => shared.recordingsDir),
  getCachePath: vi.fn(() => os.tmpdir()),
  saveRecording: vi.fn(async (filename: string, data: Buffer) => {
    const out = path.join(shared.recordingsDir, filename)
    fs.writeFileSync(out, data)
    return out
  })
}))

vi.mock('../vector-store', () => ({
  getVectorStore: vi.fn(() => null)
}))

vi.mock('@google/generative-ai', () => {
  const generateContent = vi.fn(async (arg: unknown) => {
    if (Array.isArray(arg)) {
      // Audio (ASR) call — inlineData + prompt array.
      shared.audioCalls += 1
      return { response: { text: () => shared.audioResponse } }
    }
    // Text call — analysis prompt first, then the actionables prompt.
    shared.textCalls += 1
    const next = shared.textResponses.shift() ?? '[]'
    return { response: { text: () => next } }
  })
  class GoogleGenerativeAI {
    getGenerativeModel() {
      return { generateContent }
    }
  }
  return { GoogleGenerativeAI }
})

// ---------------------------------------------------------------------------
// Real service imports (resolved AFTER the mocks above).
// ---------------------------------------------------------------------------
import {
  initializeDatabase,
  closeDatabase,
  queryOne,
  queryAll,
  run,
  getRecordingById,
  getTranscriptByRecordingId,
  upsertTranscriptStage1
} from '../database'
import { transcribeManually } from '../transcription'

// ---------------------------------------------------------------------------
// Test helpers (no cross-service imports — inline raw INSERTs).
// ---------------------------------------------------------------------------

/** Insert a recordings row with a real on-disk audio file. */
function insertRecordingWithFile(id: string, opts?: { captureId?: string }): string {
  const filename = `${id}.hda`
  const filePath = path.join(shared.recordingsDir, filename)
  fs.writeFileSync(filePath, Buffer.from('fake-audio-bytes'))
  run(
    `INSERT OR IGNORE INTO recordings
       (id, filename, file_path, date_recorded, status, transcription_status,
        location, on_device, on_local, migrated_to_capture_id, created_at)
     VALUES (?, ?, ?, ?, 'complete', 'none', 'both', 1, 1, ?, ?)`,
    [id, filename, filePath, new Date().toISOString(), opts?.captureId ?? null, new Date().toISOString()]
  )
  return filePath
}

/** Insert a recordings row WITHOUT a usable file (path points at nothing). */
function insertRecordingNoFile(id: string, opts?: { captureId?: string }): void {
  run(
    `INSERT OR IGNORE INTO recordings
       (id, filename, file_path, date_recorded, status, transcription_status,
        location, on_device, on_local, migrated_to_capture_id, created_at)
     VALUES (?, ?, ?, ?, 'complete', 'none', 'device-only', 1, 0, ?, ?)`,
    [
      id,
      `${id}.hda`,
      path.join(shared.recordingsDir, `${id}-deleted.hda`),
      new Date().toISOString(),
      opts?.captureId ?? null,
      new Date().toISOString()
    ]
  )
}

/** Insert a knowledge_captures row so actionables FK + auto-rename resolve. */
function insertCapture(id: string, recordingId: string, title: string): void {
  run(
    `INSERT OR IGNORE INTO knowledge_captures (id, title, category, status, source_recording_id, captured_at)
     VALUES (?, ?, 'meeting', 'ready', ?, ?)`,
    [id, title, recordingId, new Date().toISOString()]
  )
}

const validAnalysisJson = (title = 'T') =>
  JSON.stringify({
    summary: 'S',
    action_items: [],
    topics: [],
    key_points: [],
    title_suggestion: title,
    question_suggestions: [],
    language: 'en'
  })

const oneActionableJson = () =>
  JSON.stringify([
    {
      type: 'meeting_minutes',
      confidence: 0.9,
      suggestedTitle: 'Send meeting notes',
      reason: 'speaker said send the notes to the team after the call',
      suggestedTemplate: 'meeting_minutes'
    }
  ])

// A long transcript (>=100 words) so detectActionables runs instead of skipping.
const LONG_TEXT = Array(120).fill('word').join(' ')

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('two-stage worker (auto-pipeline P1, spec §5.3)', () => {
  beforeEach(async () => {
    fs.mkdirSync(shared.dataDir, { recursive: true })
    fs.mkdirSync(shared.recordingsDir, { recursive: true })
    if (fs.existsSync(shared.dbPath)) fs.rmSync(shared.dbPath)
    shared.audioResponse = 'FULL TEXT'
    shared.textResponses = []
    shared.audioCalls = 0
    shared.textCalls = 0
    vi.clearAllMocks()
    await initializeDatabase()
  })

  afterEach(() => {
    try {
      closeDatabase()
    } catch {
      /* ignore */
    }
  })

  it('full run writes both stages and the marker', async () => {
    insertRecordingWithFile('rec1')
    shared.audioResponse = 'FULL TEXT'
    shared.textResponses = [validAnalysisJson('My Title'), '[]'] // analysis, then actionables

    await transcribeManually('rec1')

    const row = getTranscriptByRecordingId('rec1')!
    expect(row.full_text).toBe('FULL TEXT')
    expect(row.summary).toBe('S')
    expect(row.transcription_provider).toBe('gemini')
    expect(row.summarization_provider).toBe('gemini')
    expect(row.language).toBe('en') // COALESCE path (Stage-1 wrote NULL)
    expect(getRecordingById('rec1')!.transcription_status).toBe('complete')
  })

  it('Stage-2 extraction failure THROWS and leaves the marker NULL with full_text persisted', async () => {
    insertRecordingWithFile('rec2')
    shared.audioResponse = 'FULL TEXT'
    shared.textResponses = ['no json here at all'] // analysis call -> unparseable

    await expect(transcribeManually('rec2')).rejects.toThrow(/extraction/i)

    const row = getTranscriptByRecordingId('rec2')!
    expect(row.full_text).toBe('FULL TEXT') // Stage 1 persisted before the failure
    expect(row.summarization_provider).toBeNull() // marker NULL = Stage 2 incomplete
    expect(row.summary ?? null).toBeNull() // no sentinel ever written
  })

  it('stage-resume: full_text + NULL marker -> Stage 2 only (no ASR call, no file needed)', async () => {
    insertRecordingNoFile('rec3')
    // Pre-seed Stage 1 output; audio file does NOT exist on disk.
    upsertTranscriptStage1({
      recording_id: 'rec3',
      full_text: 'PRE-EXISTING TRANSCRIPT',
      language: undefined,
      word_count: 2,
      transcription_provider: 'gemini',
      transcription_model: 'gemini-2.0-flash'
    })
    shared.textResponses = [validAnalysisJson('Resumed'), '[]']

    await transcribeManually('rec3')

    expect(shared.audioCalls).toBe(0) // ASR skipped
    const row = getTranscriptByRecordingId('rec3')!
    expect(row.full_text).toBe('PRE-EXISTING TRANSCRIPT')
    expect(row.summarization_provider).toBe('gemini')
  })

  it('short-circuit: full_text + marker set -> no-op success', async () => {
    insertRecordingNoFile('rec4')
    upsertTranscriptStage1({
      recording_id: 'rec4',
      full_text: 'ALREADY DONE',
      language: 'en',
      word_count: 2,
      transcription_provider: 'gemini',
      transcription_model: 'gemini-2.0-flash'
    })
    // Mark Stage 2 complete (set the marker).
    run("UPDATE transcripts SET summary='S', summarization_provider='gemini' WHERE recording_id='rec4'")

    await transcribeManually('rec4')

    expect(shared.audioCalls).toBe(0)
    expect(shared.textCalls).toBe(0)
    expect(getRecordingById('rec4')!.transcription_status).toBe('complete')
  })

  it('auto-rename only when pre-existing title_suggestion was NULL', async () => {
    // capture title looks like a filename so updateKnowledgeCaptureTitle will rewrite it.
    insertRecordingWithFile('rec5', { captureId: 'cap5' })
    insertCapture('cap5', 'rec5', 'rec5.hda')

    // First run: title_suggestion is NULL -> rename happens.
    shared.audioResponse = 'FULL TEXT'
    shared.textResponses = [validAnalysisJson('First Title'), '[]']
    await transcribeManually('rec5')

    expect(queryOne<{ title: string }>("SELECT title FROM knowledge_captures WHERE id='cap5'")?.title).toBe(
      'First Title'
    )

    // Clear the marker (resummarize semantics) but KEEP the title_suggestion.
    run("UPDATE transcripts SET summarization_provider=NULL WHERE recording_id='rec5'")

    // Second run with a NEW title -> rename must NOT happen (title_suggestion was non-NULL).
    shared.textResponses = [validAnalysisJson('Second Title'), '[]']
    await transcribeManually('rec5')

    expect(queryOne<{ title: string }>("SELECT title FROM knowledge_captures WHERE id='cap5'")?.title).toBe(
      'First Title' // unchanged — not renamed on the resummarize run
    )
  })

  it('actionables are delete-and-replace for pending rows (no duplicates on re-run)', async () => {
    insertRecordingWithFile('rec6', { captureId: 'cap6' })
    insertCapture('cap6', 'rec6', 'Existing Title')

    // A long transcript so the actionable detector runs (>=100 words).
    shared.audioResponse = LONG_TEXT

    // First run: analysis JSON, then one actionable.
    shared.textResponses = [validAnalysisJson('A'), oneActionableJson()]
    await transcribeManually('rec6')
    expect(
      queryAll("SELECT id FROM actionables WHERE source_knowledge_id='cap6' AND status='pending'").length
    ).toBe(1)

    // Clear the marker and re-run: same single actionable detected again.
    run("UPDATE transcripts SET summarization_provider=NULL WHERE recording_id='rec6'")
    shared.textResponses = [validAnalysisJson('A'), oneActionableJson()]
    await transcribeManually('rec6')

    // Delete-and-replace for pending rows -> still exactly one.
    expect(
      queryAll("SELECT id FROM actionables WHERE source_knowledge_id='cap6' AND status='pending'").length
    ).toBe(1)
  })
})
