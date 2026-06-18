/**
 * assemblyai-seam.test.ts — worker→DB integration seam test (spec 2026-06-17 §6.3)
 *
 * Verifies the PRODUCTION caller seam: the transcription worker must pass
 * `turns` from the ASR result into `upsertTranscriptStage1`, so that
 * `transcripts.turns/speakers/sentiment` are persisted and
 * `transcription_model` reflects the AssemblyAI model (not the Gemini one).
 *
 * Uses a REAL sql.js in-memory DB (same boundary-mock pattern as
 * two-stage-worker.test.ts / e2e-smoke.test.ts). External boundaries mocked:
 * electron, config, file-storage, vector-store, and the asr-provider factory.
 * The Gemini SDK is NOT mocked here (AssemblyAI path bypasses it).
 *
 * RED → GREEN: the test MUST fail before fixes #1/#2 in transcription.ts and
 * pass after.
 */
// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'
import type { Turn } from '../asr/asr-provider'

// ---------------------------------------------------------------------------
// Hoisted shared state — temp dir + per-test ASR stub routing.
// ---------------------------------------------------------------------------
const shared = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _os = require('os') as typeof import('os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _fs = require('fs') as typeof import('fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _path = require('path') as typeof import('path')

  const tmpDir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'hidock-aai-seam-'))
  const dataDir = _path.join(tmpDir, 'data')
  const recordingsDir = _path.join(tmpDir, 'recordings')
  _fs.mkdirSync(dataDir, { recursive: true })
  _fs.mkdirSync(recordingsDir, { recursive: true })

  return {
    tmpDir,
    dataDir,
    recordingsDir,
    dbPath: _path.join(dataDir, 'hidock.db'),
    // Per-test ASR stub output — set before each test.
    asrText: 'stub asr text' as string,
    asrTurns: undefined as Turn[] | undefined,
    // Per-test config overrides.
    transcriptionProvider: 'assemblyai' as string,
    assemblyaiModels: ['universal-3-pro', 'universal-2'] as string[],
    // Gemini Stage-2 text response queue (FIFO).
    textResponses: [] as string[],
    textCalls: 0,
    // Stage-2 LLM provider (default = gemini so we can reuse the Gemini mock for Stage 2).
    summarizationProvider: 'gemini' as string
  }
})

// ---------------------------------------------------------------------------
// External-boundary mocks.
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
      provider: shared.transcriptionProvider,
      geminiApiKey: 'test-gemini-key',
      geminiModel: 'gemini-2.0-flash',
      assemblyaiApiKey: 'test-aai-key',
      assemblyaiModels: shared.assemblyaiModels,
      openaiApiKey: '',
      whisperModel: 'whisper-1',
      autoTranscribe: false,
      language: 'en'
    },
    summarization: {
      provider: shared.summarizationProvider,
      ollamaCloudApiKey: '',
      ollamaCloudModel: ''
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
  getVectorStore: vi.fn(() => ({
    indexTranscript: async () => 0
  }))
}))

/**
 * Mock the ASR-provider factory so the worker gets a stub AssemblyAI provider
 * that returns `shared.asrText` + `shared.asrTurns` — no real HTTP, no USB.
 */
vi.mock('../asr/asr-provider', () => ({
  getAsrProvider: vi.fn(() => ({
    transcribe: vi.fn(async () => ({
      text: shared.asrText,
      language: 'en',
      turns: shared.asrTurns
    }))
  }))
}))

/**
 * Mock Gemini SDK for Stage-2 analysis (same FIFO-queue pattern as
 * two-stage-worker.test.ts). Stage-1 goes through the asr-provider mock above,
 * so `Array.isArray(arg)` never fires here for the assemblyai path.
 */
vi.mock('@google/generative-ai', () => {
  const generateContent = vi.fn(async (arg: unknown) => {
    shared.textCalls += 1
    if (typeof arg === 'string') {
      const next = shared.textResponses.shift() ?? '[]'
      return { response: { text: () => next } }
    }
    // Should not reach here for the assemblyai path (no Gemini ASR).
    throw new Error('Unexpected Gemini audio call in assemblyai-seam test')
  })
  class GoogleGenerativeAI {
    getGenerativeModel() {
      return { generateContent }
    }
  }
  return { GoogleGenerativeAI }
})

// ---------------------------------------------------------------------------
// Real service imports (after mocks).
// ---------------------------------------------------------------------------
import {
  initializeDatabase,
  closeDatabase,
  run,
  getTranscriptByRecordingId,
  clearTranscriptForRetranscribe,
  deleteRecordingSpeakersForRecording
} from '../database'
import { transcribeManually } from '../transcription'

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function insertRecordingWithFile(id: string): void {
  const filename = `${id}.hda`
  const filePath = path.join(shared.recordingsDir, filename)
  fs.writeFileSync(filePath, Buffer.from('fake-audio-bytes'))
  run(
    `INSERT OR IGNORE INTO recordings
       (id, filename, file_path, date_recorded, status, transcription_status,
        location, on_device, on_local, migrated_to_capture_id, created_at)
     VALUES (?, ?, ?, ?, 'complete', 'none', 'both', 1, 1, ?, ?)`,
    [id, filename, filePath, new Date().toISOString(), null, new Date().toISOString()]
  )
}

const validAnalysisJson = () =>
  JSON.stringify({
    summary: 'S',
    action_items: [],
    topics: [],
    key_points: [],
    title_suggestion: 'T',
    question_suggestions: [],
    language: 'en'
  })

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('assemblyai worker→DB seam (speaker diarization §6.3)', () => {
  beforeEach(async () => {
    fs.mkdirSync(shared.dataDir, { recursive: true })
    fs.mkdirSync(shared.recordingsDir, { recursive: true })
    if (fs.existsSync(shared.dbPath)) fs.rmSync(shared.dbPath)
    shared.asrText = 'lets ship it agreed'
    shared.asrTurns = undefined
    shared.textResponses = []
    shared.textCalls = 0
    shared.transcriptionProvider = 'assemblyai'
    shared.assemblyaiModels = ['universal-3-pro', 'universal-2']
    shared.summarizationProvider = 'gemini'
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

  /**
   * SEAM TEST — the critical RED→GREEN case.
   *
   * The worker must pass `asrResult.turns` to `upsertTranscriptStage1` so that:
   *   1. `transcripts.turns` is persisted (not NULL).
   *   2. `transcripts.speakers` contains the derived roster (not NULL).
   *   3. `transcripts.sentiment` contains the derived summary (not NULL).
   *   4. `transcripts.transcription_model` reflects the AssemblyAI model, NOT
   *      the Gemini model name.
   *
   * Before fix #1: turns is omitted from the upsert call → turns/speakers/sentiment all NULL.
   * Before fix #2: the model arm is missing → transcription_model = 'gemini-2.0-flash'.
   * After both fixes: all four assertions pass.
   */
  it('worker passes ASR turns to upsertTranscriptStage1 — turns/speakers/sentiment persisted; model is assemblyai (RED→GREEN seam)', async () => {
    const sampleTurns: Turn[] = [
      { speaker: 'A', startMs: 0, endMs: 1000, text: 'lets ship it', sentiment: 'POSITIVE' },
      { speaker: 'B', startMs: 1000, endMs: 2000, text: 'agreed', sentiment: 'POSITIVE' }
    ]
    shared.asrText = 'lets ship it agreed'
    shared.asrTurns = sampleTurns
    // 4-word transcript: below 100-word guard, so detectActionables skips →
    // exactly one Stage-2 text call (analysis only).
    shared.textResponses = [validAnalysisJson()]

    insertRecordingWithFile('recSeam1')
    await transcribeManually('recSeam1')

    const row = getTranscriptByRecordingId('recSeam1')!
    expect(row).not.toBeNull()

    // --- Fix #1: turns must be persisted (not NULL) ---
    const persistedTurns = row.turns ? JSON.parse(row.turns as string) : null
    expect(persistedTurns).not.toBeNull()
    expect(Array.isArray(persistedTurns)).toBe(true)
    expect(persistedTurns).toHaveLength(2)
    expect(persistedTurns[0].speaker).toBe('A')
    expect(persistedTurns[1].speaker).toBe('B')

    // --- Fix #1: speakers roster derived from turns (not NULL) ---
    const persistedSpeakers = row.speakers ? JSON.parse(row.speakers as string) : null
    expect(persistedSpeakers).not.toBeNull()
    expect(Array.isArray(persistedSpeakers)).toBe(true)
    expect(persistedSpeakers).toContain('A')
    expect(persistedSpeakers).toContain('B')

    // --- Fix #1: sentiment summary derived from turns (not NULL) ---
    const persistedSentiment = row.sentiment ? JSON.parse(row.sentiment as string) : null
    expect(persistedSentiment).not.toBeNull()
    // Both turns are POSITIVE → sentiment object has entries for A and B.
    expect(persistedSentiment).toHaveProperty('A', 'POSITIVE')
    expect(persistedSentiment).toHaveProperty('B', 'POSITIVE')

    // --- Fix #2: transcription_model must NOT be 'gemini-2.0-flash' (the Gemini model) ---
    expect(row.transcription_model).not.toBe('gemini-2.0-flash')
    // Must reflect the AssemblyAI model (first element of assemblyaiModels).
    expect(row.transcription_model).toBe('universal-3-pro,universal-2')

    // Sanity: provider and full_text are correct.
    expect(row.transcription_provider).toBe('assemblyai')
    expect(row.full_text).toBe('lets ship it agreed')
    expect(row.summary).toBe('S')
  })

  /**
   * Regression: Gemini/Whisper paths (no turns) must still produce NULL
   * turns/speakers/sentiment (backward-compat, spec §6.3).
   */
  it('gemini path (no turns) → turns/speakers/sentiment remain NULL; model is gemini (regression)', async () => {
    shared.transcriptionProvider = 'gemini'
    shared.asrText = 'hello world'
    shared.asrTurns = undefined // Gemini does not produce turns
    shared.textResponses = [validAnalysisJson()]

    insertRecordingWithFile('recSeam2')
    await transcribeManually('recSeam2')

    const row = getTranscriptByRecordingId('recSeam2')!
    expect(row.turns ?? null).toBeNull()
    expect(row.speakers ?? null).toBeNull()
    expect(row.sentiment ?? null).toBeNull()
    expect(row.transcription_model).toBe('gemini-2.0-flash')
    expect(row.transcription_provider).toBe('gemini')
  })
})

/**
 * Re-transcribe seam (D5 §6.8 / AC6) — the path that was a SILENT NO-OP in the
 * live app: the worker short-circuits when `full_text && summarization_provider`
 * are both set, so a forced re-transcribe MUST first clear those markers (what
 * the `recordings:transcribe` IPC does via clearTranscriptForRetranscribe +
 * deleteRecordingSpeakersForRecording). These two tests pin both halves end-to-end
 * against a REAL sql.js DB: clear → fresh re-run; no clear → short-circuit.
 */
describe('re-transcribe seam (§6.8 / AC6)', () => {
  beforeEach(async () => {
    fs.mkdirSync(shared.dataDir, { recursive: true })
    fs.mkdirSync(shared.recordingsDir, { recursive: true })
    if (fs.existsSync(shared.dbPath)) fs.rmSync(shared.dbPath)
    shared.textResponses = []
    shared.textCalls = 0
    shared.transcriptionProvider = 'assemblyai'
    shared.assemblyaiModels = ['universal-3-pro', 'universal-2']
    shared.summarizationProvider = 'gemini'
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

  it('clearing the markers (what recordings:transcribe does) makes the worker re-run FRESH — no short-circuit', async () => {
    insertRecordingWithFile('recReta')

    // First pass: 2 speakers.
    shared.asrText = 'first take ok'
    shared.asrTurns = [
      { speaker: 'A', startMs: 0, endMs: 1000, text: 'first take' },
      { speaker: 'B', startMs: 1000, endMs: 2000, text: 'ok' }
    ]
    shared.textResponses = [validAnalysisJson()]
    await transcribeManually('recReta')

    const first = getTranscriptByRecordingId('recReta')!
    expect(first.full_text).toBe('first take ok')
    expect(JSON.parse(first.turns as string)).toHaveLength(2)
    expect(first.summarization_provider).toBeTruthy() // fully transcribed → would short-circuit

    // Re-transcribe: clear BOTH stage markers + drop mappings, exactly as the
    // recordings:transcribe IPC handler does before enqueueing.
    clearTranscriptForRetranscribe('recReta')
    deleteRecordingSpeakersForRecording('recReta')

    // Second pass returns DIFFERENT, 3-speaker output.
    shared.asrText = 'second take sure new voice'
    shared.asrTurns = [
      { speaker: 'A', startMs: 0, endMs: 1000, text: 'second take' },
      { speaker: 'B', startMs: 1000, endMs: 2000, text: 'sure' },
      { speaker: 'C', startMs: 2000, endMs: 3000, text: 'new voice' }
    ]
    shared.textResponses = [validAnalysisJson()]
    await transcribeManually('recReta')

    // Worker did NOT short-circuit — the transcript reflects the SECOND run.
    const second = getTranscriptByRecordingId('recReta')!
    expect(second.full_text).toBe('second take sure new voice')
    const turns2 = JSON.parse(second.turns as string)
    expect(turns2).toHaveLength(3)
    expect(JSON.parse(second.speakers as string)).toContain('C')
  })

  it('WITHOUT clearing, re-transcribing a complete recording short-circuits (documents the live no-op the fix prevents)', async () => {
    insertRecordingWithFile('recRetb')

    shared.asrText = 'original transcript'
    shared.asrTurns = [
      { speaker: 'A', startMs: 0, endMs: 1000, text: 'original' },
      { speaker: 'B', startMs: 1000, endMs: 2000, text: 'transcript' }
    ]
    shared.textResponses = [validAnalysisJson()]
    await transcribeManually('recRetb')

    // No clear. Stage a totally different ASR result, then re-run the worker.
    shared.asrText = 'this should never be written'
    shared.asrTurns = [{ speaker: 'A', startMs: 0, endMs: 500, text: 'changed' }]
    shared.textResponses = [validAnalysisJson()]
    await transcribeManually('recRetb')

    // Short-circuited: the transcript is UNCHANGED from the first pass.
    const row = getTranscriptByRecordingId('recRetb')!
    expect(row.full_text).toBe('original transcript')
    expect(JSON.parse(row.turns as string)).toHaveLength(2)
  })
})

afterAll(() => {
  try {
    fs.rmSync(shared.tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore — Windows can hold handles briefly */
  }
})
