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

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
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
    textCalls: 0,
    // Auto-pipeline P3 (spec §5.4): per-test summarization config so a test can
    // flip the Stage-2 LLM to ollama-cloud. Default = today's gemini behavior.
    summarization: {
      provider: 'gemini' as 'gemini' | 'ollama-cloud',
      ollamaCloudApiKey: '' as string,
      ollamaCloudModel: '' as string
    },
    // Captures the meta arg the worker hands the vector store at indexing time
    // (spec §5.2: the meeting-selection validator must scrub 'none'/hallucinated
    // ids out of the indexing fallback before they reach chunk metadata).
    lastIndexMeta: undefined as { meetingId?: string; recordingId?: string } | undefined,
    // D5 §6.6: spy hook — called with the full prompt string on each text (analysis/actionables) call.
    onTextCall: undefined as ((prompt: string) => void) | undefined
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
    },
    // Auto-pipeline P3 (spec §5.4): config.summarization drives the Stage-2 LLM
    // factory. The mock bypasses config.ts's deep-merge defaults, so without this
    // section the worker TypeErrors the moment it reads config.summarization.provider.
    // Read from shared so a test can flip the provider to ollama-cloud per-case.
    summarization: { ...shared.summarization }
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
  // Quiet stub: the worker's indexing tail runs for real and "indexes" 0 chunks,
  // keeping the test output free of a noisy null-deref warning. Captures the meta
  // arg so the validator tests can assert what reaches chunk metadata (spec §5.2).
  getVectorStore: vi.fn(() => ({
    indexTranscript: async (_text: string, meta: { meetingId?: string; recordingId?: string }) => {
      shared.lastIndexMeta = meta
      return 0
    }
  }))
}))

vi.mock('@google/generative-ai', () => {
  const generateContent = vi.fn(async (arg: unknown) => {
    if (Array.isArray(arg)) {
      // Audio (ASR) call — inlineData + prompt array.
      shared.audioCalls += 1
      return { response: { text: () => shared.audioResponse } }
    }
    // Text call — analysis prompt first; an actionables prompt follows ONLY
    // when the transcript passes detectActionables' 100-word guard.
    // The '__LLM_THROW__' sentinel makes this call reject (transient LLM failure).
    shared.textCalls += 1
    if (typeof arg === 'string') shared.onTextCall?.(arg)
    const next = shared.textResponses.shift() ?? '[]'
    if (next === '__LLM_THROW__') throw new Error('LLM transient failure')
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
  upsertTranscriptStage1,
  clearTranscriptStage2Marker
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

/** Insert a contacts row so attributed-summary mapping resolves. */
function insertContact(id: string, name: string): void {
  const now = new Date().toISOString()
  run(
    `INSERT OR IGNORE INTO contacts (id, name, type, first_seen_at, last_seen_at, created_at)
     VALUES (?, ?, 'unknown', ?, ?, ?)`,
    [id, name, now, now, now]
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

/** Insert a meeting that overlaps "now" so findCandidateMeetingsForRecording
 *  returns it for recordings stamped with new Date() (the helpers above). */
function insertMeeting(id: string, subject: string): void {
  const now = Date.now()
  run(
    `INSERT OR IGNORE INTO meetings (id, subject, start_time, end_time, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      id,
      subject,
      new Date(now - 5 * 60 * 1000).toISOString(),
      new Date(now + 25 * 60 * 1000).toISOString(),
      new Date().toISOString()
    ]
  )
}

/** Point a recording's original meeting_id at an existing meeting (the validator
 *  must use THIS, not 'none'/hallucinated, in the indexing fallback — spec §5.2). */
function setRecordingMeetingId(recordingId: string, meetingId: string): void {
  run('UPDATE recordings SET meeting_id = ? WHERE id = ?', [meetingId, recordingId])
}

/** Build an ollama.com/api/chat-shaped fetch stub: returns the next queued
 *  body as message.content, in FIFO order (analysis, then actionables). Used by
 *  the ollama-cloud Stage-2 tests, which BYPASS the Gemini mock. */
function stubOllamaChatFetch(bodies: string[]): void {
  const queue = [...bodies]
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ message: { content: queue.shift() ?? '[]' } })
    }))
  )
}

const analysisWithMeeting = (selectedId: unknown, confidence: unknown) =>
  JSON.stringify({
    summary: 'S',
    action_items: [],
    topics: [],
    key_points: [],
    title_suggestion: 'T',
    question_suggestions: [],
    language: 'en',
    selected_meeting_id: selectedId,
    meeting_confidence: confidence,
    selection_reason: 'r'
  })

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

/** Analysis JSON with caller-chosen summary + title (resummarize tests need a
 *  DIFFERENT summary on the second run than the first to prove replacement). */
const analysisJson = (summary: string, title: string) =>
  JSON.stringify({
    summary,
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
    shared.summarization = { provider: 'gemini', ollamaCloudApiKey: '', ollamaCloudModel: '' }
    shared.lastIndexMeta = undefined
    shared.onTextCall = undefined
    vi.clearAllMocks()
    vi.unstubAllGlobals() // drop any per-test fetch stub
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
    // Analysis only: 'FULL TEXT' is 2 words, so detectActionables' <100-word
    // guard skips the second text call.
    shared.textResponses = [validAnalysisJson('My Title')]

    await transcribeManually('rec1')

    const row = getTranscriptByRecordingId('rec1')!
    expect(row.full_text).toBe('FULL TEXT')
    expect(row.summary).toBe('S')
    expect(row.transcription_provider).toBe('gemini')
    expect(row.summarization_provider).toBe('gemini')
    expect(row.language).toBe('en') // COALESCE path (Stage-1 wrote NULL)
    expect(shared.textCalls).toBe(1) // analysis ran; actionables skipped (<100 words)
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
    // Analysis only: the 3-word transcript skips actionable detection.
    shared.textResponses = [validAnalysisJson('Resumed')]

    await transcribeManually('rec3')

    expect(shared.audioCalls).toBe(0) // ASR skipped
    expect(shared.textCalls).toBe(1) // analysis only
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
    // (Analysis only per run — 2-word transcript skips actionable detection.)
    shared.audioResponse = 'FULL TEXT'
    shared.textResponses = [validAnalysisJson('First Title')]
    await transcribeManually('rec5')

    expect(shared.textCalls).toBe(1)
    expect(queryOne<{ title: string }>("SELECT title FROM knowledge_captures WHERE id='cap5'")?.title).toBe(
      'First Title'
    )

    // Clear the marker (resummarize semantics) but KEEP the title_suggestion.
    run("UPDATE transcripts SET summarization_provider=NULL WHERE recording_id='rec5'")

    // Second run with a NEW title -> rename must NOT happen (title_suggestion was non-NULL).
    shared.textResponses = [validAnalysisJson('Second Title')]
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

  it('detection failure (LLM throws) does NOT wipe pre-existing pending actionables', async () => {
    insertRecordingWithFile('rec7', { captureId: 'cap7' })
    insertCapture('cap7', 'rec7', 'Existing Title')
    // Pending actionable left over from an earlier successful run.
    run(
      `INSERT INTO actionables (id, source_knowledge_id, type, title, status, confidence, created_at)
       VALUES ('act_pre', 'cap7', 'meeting_minutes', 'Pre-existing card', 'pending', 0.9, ?)`,
      [new Date().toISOString()]
    )

    // Long transcript so detection actually RUNS — and its LLM call fails.
    shared.audioResponse = LONG_TEXT
    shared.textResponses = [validAnalysisJson('A'), '__LLM_THROW__']

    // Actionable-detection failure is graceful: the job still completes.
    await transcribeManually('rec7')
    expect(getRecordingById('rec7')!.transcription_status).toBe('complete')

    // detectActionables returned null (failed run) -> the delete-and-replace
    // block is skipped entirely -> the pre-existing pending card SURVIVES.
    expect(
      queryAll("SELECT id FROM actionables WHERE source_knowledge_id='cap7' AND status='pending'").length
    ).toBe(1)
  })

  // -------------------------------------------------------------------------
  // Auto-pipeline P3 (spec §5.2): meeting-selection validator
  // -------------------------------------------------------------------------

  it("validator: selected_meeting_id 'none' -> undefined; indexing falls back to recording.meeting_id (not 'none')", async () => {
    insertRecordingWithFile('recV1')
    insertMeeting('mV1', 'Sprint Planning')
    setRecordingMeetingId('recV1', 'mV1') // the recording's ORIGINAL meeting

    shared.audioResponse = 'FULL TEXT'
    // One candidate present; the LLM picks 'none'.
    shared.textResponses = [analysisWithMeeting('none', 0.9)]

    await transcribeManually('recV1')

    // No AI link was made (selection invalidated) — the original link survives.
    // Critically, the indexing metadata used the ORIGINAL meeting_id, never 'none'.
    expect(shared.lastIndexMeta?.meetingId).toBe('mV1')
    expect(shared.lastIndexMeta?.meetingId).not.toBe('none')
  })

  it('validator: hallucinated id (not in candidate set) -> undefined; no link, candidate isSelected=false, indexing uses original', async () => {
    insertRecordingWithFile('recV2')
    insertMeeting('mV2', 'Design Review')
    setRecordingMeetingId('recV2', 'mV2')

    shared.audioResponse = 'FULL TEXT'
    // The LLM hallucinates an id that is not among the candidates.
    shared.textResponses = [analysisWithMeeting('mHALLUCINATED', 0.95)]

    await transcribeManually('recV2')

    // Hallucinated id never reaches chunk metadata — original meeting_id used.
    expect(shared.lastIndexMeta?.meetingId).toBe('mV2')
    expect(shared.lastIndexMeta?.meetingId).not.toBe('mHALLUCINATED')
    // The real candidate was written but NOT selected.
    const candidate = queryOne<{ is_selected: number }>(
      "SELECT is_selected FROM recording_meeting_candidates WHERE recording_id='recV2' AND meeting_id='mV2'"
    )
    expect(candidate?.is_selected).toBe(0)
  })

  it('validator: string meeting_confidence is coerced via Number() and clamped to 0..1; link proceeds (>=0.4)', async () => {
    insertRecordingWithFile('recV3')
    insertMeeting('mV3', 'Budget Sync')

    shared.audioResponse = 'FULL TEXT'
    // Valid candidate selected, but the model returned an out-of-range STRING
    // confidence ('1.5'). The validator must Number()-coerce AND clamp to 1.
    shared.textResponses = [analysisWithMeeting('mV3', '1.5')]

    await transcribeManually('recV3')

    const rec = getRecordingById('recV3')!
    // Link proceeded: meeting_id set to the selected candidate.
    expect(rec.meeting_id).toBe('mV3')
    // Confidence coerced to a NUMBER and clamped to the 0..1 ceiling (not 1.5).
    expect(rec.correlation_confidence).toBe(1)
    expect(typeof rec.correlation_confidence).toBe('number')
  })

  // -------------------------------------------------------------------------
  // Auto-pipeline P3 (spec §5.2/§5.4): Stage-2 provider/model derived from config
  // -------------------------------------------------------------------------

  it('summarization.provider=ollama-cloud -> Stage-2 columns reflect ollama-cloud + its model (via fetch, not the Gemini mock)', async () => {
    insertRecordingWithFile('recO1')
    shared.summarization = {
      provider: 'ollama-cloud',
      ollamaCloudApiKey: 'ok-key-1234567890',
      ollamaCloudModel: 'gpt-oss:120b'
    }
    shared.audioResponse = 'FULL TEXT' // Stage 1 still goes through the Gemini ASR mock
    // Stage 2 goes through createOllamaCloudLlm -> global fetch. 'FULL TEXT' is
    // 2 words so detectActionables is skipped -> exactly one Stage-2 fetch call.
    stubOllamaChatFetch([validAnalysisJson('Ollama Title')])

    await transcribeManually('recO1')

    const row = getTranscriptByRecordingId('recO1')!
    expect(row.full_text).toBe('FULL TEXT')
    expect(row.summary).toBe('S')
    expect(row.summarization_provider).toBe('ollama-cloud')
    expect(row.summarization_model).toBe('gpt-oss:120b')
    // The Gemini text path was NOT used for Stage 2 (only the ASR audio call ran).
    expect(shared.audioCalls).toBe(1)
    expect(shared.textCalls).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Auto-pipeline P3 -> P4 AC5 seam (spec §5.3): Stage 1 persists before the
  // Stage-2 key failure, so the item is Stage-2-resumable.
  // -------------------------------------------------------------------------

  it('AC5 seam: gemini ASR + ollama-cloud summarization w/ EMPTY key -> rejects at Stage 2, full_text persisted, marker NULL', async () => {
    insertRecordingWithFile('recA5')
    shared.summarization = {
      provider: 'ollama-cloud',
      ollamaCloudApiKey: '', // missing LLM key
      ollamaCloudModel: 'gpt-oss:120b'
    }
    shared.audioResponse = 'STAGE ONE TEXT'

    await expect(transcribeManually('recA5')).rejects.toThrow(/Ollama Cloud API key not configured/)

    const row = getTranscriptByRecordingId('recA5')!
    expect(row.full_text).toBe('STAGE ONE TEXT') // Stage 1 persisted before the Stage-2 failure
    expect(row.summarization_provider).toBeNull() // Stage 2 never completed -> resumable
    expect(row.summary ?? null).toBeNull()
    expect(shared.audioCalls).toBe(1) // ASR ran exactly once
  })

  // -------------------------------------------------------------------------
  // Task 4 (auto-pipeline P3, spec §5.3/§5.6 -> AC6): resummarize via
  // clearTranscriptStage2Marker — regenerate Stage 2 with the audio file gone,
  // keep full_text, replace the summary, no duplicate actionables, no re-rename,
  // and survive an intermediate failed re-run with the OLD summary intact.
  // -------------------------------------------------------------------------

  it('resummarize: marker-clear re-runs Stage 2 only (audio deleted) — replaces summary, no duplicate actionables, no re-rename, keeps old summary on a failed re-run', async () => {
    const filePath = insertRecordingWithFile('recRS', { captureId: 'capRS' })
    insertCapture('capRS', 'recRS', 'recRS.hda') // filename-shaped title -> auto-rename eligible

    // First full run (long transcript so detectActionables RUNS): writes the
    // original summary + ONE pending actionable, and renames the capture (the
    // pre-run title_suggestion was NULL).
    shared.audioResponse = LONG_TEXT
    shared.textResponses = [analysisJson('ORIGINAL SUMMARY', 'First Title'), oneActionableJson()]
    await transcribeManually('recRS')

    expect(getTranscriptByRecordingId('recRS')!.summary).toBe('ORIGINAL SUMMARY')
    expect(getTranscriptByRecordingId('recRS')!.full_text).toBe(LONG_TEXT)
    expect(getRecordingById('recRS')!.transcription_status).toBe('complete')
    expect(
      queryAll("SELECT id FROM actionables WHERE source_knowledge_id='capRS' AND status='pending'").length
    ).toBe(1)
    expect(queryOne<{ title: string }>("SELECT title FROM knowledge_captures WHERE id='capRS'")?.title).toBe(
      'First Title' // renamed on the first run
    )

    // Delete the audio file — resummarize must work with no local audio (Stage 2
    // needs only full_text). The Stage-1 file-existence check is Stage-1-only.
    fs.rmSync(filePath)
    shared.audioCalls = 0
    shared.textCalls = 0

    // --- Intermediate FAILED re-run: clear marker, make Stage 2 throw. The old
    //     summary must survive and the marker must stay NULL (resumable). ---
    clearTranscriptStage2Marker('recRS')
    expect(getTranscriptByRecordingId('recRS')!.summarization_provider).toBeNull() // marker cleared
    expect(getTranscriptByRecordingId('recRS')!.summary).toBe('ORIGINAL SUMMARY') // summary kept across the clear
    shared.textResponses = ['no json here at all'] // analysis call -> extraction failure
    await expect(transcribeManually('recRS')).rejects.toThrow(/extraction/i)

    const afterFail = getTranscriptByRecordingId('recRS')!
    expect(afterFail.summary).toBe('ORIGINAL SUMMARY') // OLD summary survived the failed re-run
    expect(afterFail.summarization_provider).toBeNull() // still resumable
    expect(shared.audioCalls).toBe(0) // ASR never ran — Stage-2-only resume

    // --- Successful re-run: NEW summary + NEW title. Summary is replaced; the
    //     capture is NOT re-renamed (title_suggestion was non-NULL); the single
    //     actionable is delete-and-replaced (still exactly one). ---
    shared.textResponses = [analysisJson('NEW SUMMARY', 'Second Title'), oneActionableJson()]
    await transcribeManually('recRS')

    const afterOk = getTranscriptByRecordingId('recRS')!
    expect(afterOk.full_text).toBe(LONG_TEXT) // full_text untouched by Stage 2
    expect(afterOk.summary).toBe('NEW SUMMARY') // summary regenerated with the current provider
    expect(afterOk.summarization_provider).toBe('gemini') // marker re-set
    expect(shared.audioCalls).toBe(0) // ASR still never ran (audio gone, not needed)
    expect(
      queryAll("SELECT id FROM actionables WHERE source_knowledge_id='capRS' AND status='pending'").length
    ).toBe(1) // delete-and-replace -> no duplicate
    expect(queryOne<{ title: string }>("SELECT title FROM knowledge_captures WHERE id='capRS'")?.title).toBe(
      'First Title' // NOT re-renamed — title_suggestion was non-NULL before this run
    )
  })

  it('Stage-2 input is speaker-labeled when turns + mappings exist (spec §6.6 / AC5)', async () => {
    insertRecordingWithFile('recAttr')
    insertContact('cAttr', 'Dana')
    // Stage 1 already wrote full_text + turns (simulate AssemblyAI output).
    shared.audioResponse = 'flat asr text'
    const turns = [
      { speaker: 'A', startMs: 0, endMs: 1000, text: 'lets ship it' },
      { speaker: 'B', startMs: 1000, endMs: 2000, text: 'agreed' }
    ]
    // Capture exactly what the analysis (text) call receives.
    let analysisInput = ''
    shared.onTextCall = (prompt: string) => { analysisInput = prompt }
    shared.textResponses = [validAnalysisJson('Attributed')]

    // Pre-seed Stage 1 with turns + one mapping (label A -> Dana), then run Stage 2 only.
    upsertTranscriptStage1({
      recording_id: 'recAttr',
      full_text: 'lets ship it agreed',
      language: 'en',
      word_count: 4,
      transcription_provider: 'assemblyai',
      transcription_model: 'universal-3-pro'
    })
    run('UPDATE transcripts SET turns = ? WHERE recording_id = ?', [JSON.stringify(turns), 'recAttr'])
    run(
      `INSERT INTO recording_speakers (recording_id, file_label, contact_id, source, created_at)
       VALUES ('recAttr', 'A', 'cAttr', 'user', ?)`,
      [new Date().toISOString()]
    )

    await transcribeManually('recAttr')

    // The analysis prompt embedded the attributed transcript: Dana mapped, B generic.
    expect(analysisInput).toContain('Dana: lets ship it')
    expect(analysisInput).toContain('Speaker B: agreed')
    expect(shared.audioCalls).toBe(0) // Stage-2-only resume (full_text already present)
  })
})

afterAll(() => {
  try {
    fs.rmSync(shared.tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore — Windows can hold handles briefly */
  }
})
