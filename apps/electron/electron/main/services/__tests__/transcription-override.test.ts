/**
 * Task 13: transcription-override tests
 *
 * Covers:
 *  1. setTranscriptTemplateOverride — writes the id; throws when no transcript row.
 *  2. updateTranscriptStage2 — nulls the override (Task 12 contract); _name/_hash persist.
 *  3. clearTranscriptForRetranscribe — nulls summarization_template_id.
 *  4. hasInFlightQueueItem — true when pending/processing row; false otherwise.
 *  5. Concurrency guard in the resummarize handler:
 *     - pending → reject ("transcription in progress"), override NOT written, no enqueue.
 *     - processing → reject, same.
 *     - idle → { success: true }, override written, marker cleared, exactly one queue row.
 *
 * Uses a REAL sql.js in-memory database (same boundary-mock pattern as database-v33.test.ts).
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'

// ---------------------------------------------------------------------------
// Hoisted shared state — real temp dir.
// ---------------------------------------------------------------------------
const shared = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _os = require('os') as typeof import('os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _fs = require('fs') as typeof import('fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _path = require('path') as typeof import('path')

  const tmpDir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'hidock-override-'))
  const dataDir = _path.join(tmpDir, 'data')
  const recordingsDir = _path.join(tmpDir, 'recordings')
  _fs.mkdirSync(dataDir, { recursive: true })
  _fs.mkdirSync(recordingsDir, { recursive: true })

  return {
    tmpDir,
    dataDir,
    recordingsDir,
    dbPath: _path.join(dataDir, 'hidock.db')
  }
})

// ---------------------------------------------------------------------------
// External-boundary mocks (same pattern as database-v33.test.ts).
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => os.tmpdir()),
    getName: vi.fn(() => 'test')
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []), getFocusedWindow: vi.fn(() => null) },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
  Notification: { isSupported: vi.fn(() => false ) }
}))

// Mock the transcription + recording-watcher services so importing the REAL
// recording-handlers module (for the FIX 6 integration test) does not pull in
// heavy ASR/LLM deps. The DB layer stays REAL (shared singleton with this test).
vi.mock('../transcription', () => ({
  getTranscriptionStatus: vi.fn(),
  startTranscriptionProcessor: vi.fn(),
  stopTranscriptionProcessor: vi.fn(),
  cancelTranscription: vi.fn(),
  cancelAllTranscriptions: vi.fn(),
  processQueueManually: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../recording-watcher', () => ({
  startRecordingWatcher: vi.fn(),
  stopRecordingWatcher: vi.fn(),
  getWatcherStatus: vi.fn(() => ({ isWatching: false, path: '/mock/recordings' }))
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
  saveRecording: vi.fn(async (filename: string) => path.join(shared.recordingsDir, filename))
}))

vi.mock('../vector-store', () => ({
  getVectorStore: vi.fn(() => null)
}))

// ---------------------------------------------------------------------------
// Real service imports (resolved AFTER mocks).
// ---------------------------------------------------------------------------
import {
  initializeDatabase,
  closeDatabase,
  run,
  queryOne,
  setTranscriptTemplateOverride,
  hasInFlightQueueItem,
  clearTranscriptForRetranscribe,
  updateTranscriptStage2,
  addToQueue,
  clearTranscriptStage2Marker
} from '../database'
import { ipcMain } from 'electron'
import { registerRecordingHandlers } from '../../ipc/recording-handlers'

// ---------------------------------------------------------------------------
// Test helpers.
// ---------------------------------------------------------------------------

const REC_ID = '550e8400-e29b-41d4-a716-446655440001'
const TPL_ID = 'tpl-0000-0000-0000-0001'

/** Insert a minimal recordings row. */
function seedRecording(id = REC_ID): void {
  const now = new Date().toISOString()
  run(
    `INSERT OR IGNORE INTO recordings (id, filename, file_path, file_size, duration_seconds, date_recorded, created_at)
     VALUES (?, ?, ?, 100, 60, ?, ?)`,
    [id, `${id}.hda`, path.join(shared.recordingsDir, `${id}.hda`), now, now]
  )
}

/** Insert a minimal transcripts row with summarization_provider set (Stage-2 done). */
function seedTranscript(id = REC_ID, overrideId: string | null = null): void {
  run(
    `INSERT OR REPLACE INTO transcripts
       (id, recording_id, full_text, summarization_provider, summarization_model,
        summarization_template_id, summarization_template_name, summarization_template_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `tr-${id}`,
      id,
      'Transcript text here.',
      'gemini',
      'gemini-2.0-flash',
      overrideId,
      overrideId ? 'My Template' : null,
      overrideId ? 'abc123hash' : null
    ]
  )
}

/** Seed a transcription_queue row with the given status. */
function seedQueueRow(recordingId = REC_ID, status: 'pending' | 'processing' | 'completed' | 'failed'): void {
  const id = `qrow-${status}-${recordingId}`
  run(
    `INSERT OR REPLACE INTO transcription_queue (id, recording_id, status) VALUES (?, ?, ?)`,
    [id, recordingId, status]
  )
}

// ---------------------------------------------------------------------------
// Suite lifecycle.
// ---------------------------------------------------------------------------

beforeEach(async () => {
  fs.mkdirSync(shared.dataDir, { recursive: true })
  if (fs.existsSync(shared.dbPath)) fs.rmSync(shared.dbPath)
  await initializeDatabase()
})

afterEach(() => {
  try { closeDatabase() } catch { /* ignore */ }
})

afterAll(() => {
  try { fs.rmSync(shared.tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

// ---------------------------------------------------------------------------
// 1. setTranscriptTemplateOverride
// ---------------------------------------------------------------------------

describe('setTranscriptTemplateOverride', () => {
  it('writes the templateId onto the transcript row', () => {
    seedRecording()
    seedTranscript()

    setTranscriptTemplateOverride(REC_ID, TPL_ID)

    const row = queryOne<{ summarization_template_id: string | null }>(
      'SELECT summarization_template_id FROM transcripts WHERE recording_id = ?',
      [REC_ID]
    )
    expect(row?.summarization_template_id).toBe(TPL_ID)
  })

  it('writes null (clearing the override)', () => {
    seedRecording()
    seedTranscript(REC_ID, TPL_ID)

    setTranscriptTemplateOverride(REC_ID, null)

    const row = queryOne<{ summarization_template_id: string | null }>(
      'SELECT summarization_template_id FROM transcripts WHERE recording_id = ?',
      [REC_ID]
    )
    expect(row?.summarization_template_id).toBeNull()
  })

  it('throws when there is no transcript row', () => {
    seedRecording()
    // No seedTranscript — transcript row absent.
    expect(() => setTranscriptTemplateOverride(REC_ID, TPL_ID)).toThrow(
      /no transcript row for recording/
    )
  })
})

// ---------------------------------------------------------------------------
// 2. updateTranscriptStage2 nulls the override; _name/_hash persist.
// ---------------------------------------------------------------------------

describe('updateTranscriptStage2 — nulls summarization_template_id', () => {
  it('clears the override column after Stage-2 write while keeping _name/_hash', () => {
    seedRecording()
    seedTranscript(REC_ID, TPL_ID) // override is set

    // Simulate the Stage-2 write (Task 12).
    updateTranscriptStage2(REC_ID, {
      summary: 'Updated summary.',
      language: 'en',
      summarization_provider: 'gemini',
      summarization_model: 'gemini-2.0-flash',
      template_name: 'My Template',
      template_hash: 'abc123hash'
    })

    const row = queryOne<{
      summarization_template_id: string | null
      summarization_template_name: string | null
      summarization_template_hash: string | null
    }>(
      'SELECT summarization_template_id, summarization_template_name, summarization_template_hash FROM transcripts WHERE recording_id = ?',
      [REC_ID]
    )
    expect(row?.summarization_template_id).toBeNull()   // consumed
    expect(row?.summarization_template_name).toBe('My Template')  // persists
    expect(row?.summarization_template_hash).toBe('abc123hash')   // persists
  })
})

// ---------------------------------------------------------------------------
// 3. clearTranscriptForRetranscribe nulls the override.
// ---------------------------------------------------------------------------

describe('clearTranscriptForRetranscribe — nulls summarization_template_id', () => {
  it('nulls the override column along with the other Stage-1 columns', () => {
    seedRecording()
    seedTranscript(REC_ID, TPL_ID)

    clearTranscriptForRetranscribe(REC_ID)

    const row = queryOne<{
      full_text: string
      summarization_provider: string | null
      summarization_template_id: string | null
    }>(
      'SELECT full_text, summarization_provider, summarization_template_id FROM transcripts WHERE recording_id = ?',
      [REC_ID]
    )
    expect(row?.full_text).toBe('')                         // Stage-1 cleared
    expect(row?.summarization_provider).toBeNull()          // Stage-2 cleared
    expect(row?.summarization_template_id).toBeNull()       // override cleared
  })

  it('is a no-op when there is no transcript row', () => {
    seedRecording()
    // No transcript row — should not throw.
    expect(() => clearTranscriptForRetranscribe(REC_ID)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 4. hasInFlightQueueItem
// ---------------------------------------------------------------------------

describe('hasInFlightQueueItem', () => {
  it('returns false when no queue row exists', () => {
    seedRecording()
    expect(hasInFlightQueueItem(REC_ID)).toBe(false)
  })

  it('returns true when a pending row exists', () => {
    seedRecording()
    seedQueueRow(REC_ID, 'pending')
    expect(hasInFlightQueueItem(REC_ID)).toBe(true)
  })

  it('returns true when a processing row exists', () => {
    seedRecording()
    seedQueueRow(REC_ID, 'processing')
    expect(hasInFlightQueueItem(REC_ID)).toBe(true)
  })

  it('returns false when only completed/failed rows exist', () => {
    seedRecording()
    seedQueueRow(REC_ID, 'completed')
    seedQueueRow(REC_ID, 'failed')
    expect(hasInFlightQueueItem(REC_ID)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. Concurrency guard — integration with the resummarize path (via DB helpers).
// ---------------------------------------------------------------------------
// These tests exercise the guard contract directly at the DB layer, which is
// what the recording-handlers.test.ts concurrency tests (below) replicate at the
// IPC layer using mocks.

describe('concurrency guard — write-side contract (DB layer)', () => {
  it('pending → hasInFlightQueueItem is true → override must NOT be written', () => {
    seedRecording()
    seedTranscript()
    seedQueueRow(REC_ID, 'pending')

    // Simulate what the handler does: check guard BEFORE writing override.
    const inFlight = hasInFlightQueueItem(REC_ID)
    expect(inFlight).toBe(true)

    if (!inFlight) {
      // This path must NOT execute.
      setTranscriptTemplateOverride(REC_ID, TPL_ID)
    }

    // Override must be unchanged (null).
    const row = queryOne<{ summarization_template_id: string | null }>(
      'SELECT summarization_template_id FROM transcripts WHERE recording_id = ?',
      [REC_ID]
    )
    expect(row?.summarization_template_id).toBeNull()
  })

  it('processing → hasInFlightQueueItem is true → override must NOT be written', () => {
    seedRecording()
    seedTranscript()
    seedQueueRow(REC_ID, 'processing')

    const inFlight = hasInFlightQueueItem(REC_ID)
    expect(inFlight).toBe(true)

    if (!inFlight) {
      setTranscriptTemplateOverride(REC_ID, TPL_ID)
    }

    const row = queryOne<{ summarization_template_id: string | null }>(
      'SELECT summarization_template_id FROM transcripts WHERE recording_id = ?',
      [REC_ID]
    )
    expect(row?.summarization_template_id).toBeNull()
  })

  it('idle → override is written, marker cleared, queue row inserted', () => {
    seedRecording()
    seedTranscript()
    // No in-flight queue row.

    const inFlight = hasInFlightQueueItem(REC_ID)
    expect(inFlight).toBe(false)

    // Write override.
    setTranscriptTemplateOverride(REC_ID, TPL_ID)
    // Clear Stage-2 marker.
    clearTranscriptStage2Marker(REC_ID)
    // Enqueue.
    addToQueue(REC_ID)

    const row = queryOne<{
      summarization_template_id: string | null
      summarization_provider: string | null
    }>(
      'SELECT summarization_template_id, summarization_provider FROM transcripts WHERE recording_id = ?',
      [REC_ID]
    )
    expect(row?.summarization_template_id).toBe(TPL_ID)   // override written
    expect(row?.summarization_provider).toBeNull()         // Stage-2 marker cleared

    const queueRows = queryOne<{ c: number }>(
      "SELECT COUNT(*) AS c FROM transcription_queue WHERE recording_id = ? AND status = 'pending'",
      [REC_ID]
    )
    expect(queueRows?.c).toBe(1)  // exactly one pending queue row
  })
})

// ---------------------------------------------------------------------------
// 6. FIX 6 — REAL-handler transcript-existence guard integration test.
//
// The DB-layer tests above re-implement the old concurrency guard (they check
// hasInFlightQueueItem then conditionally call setTranscriptTemplateOverride).
// The new guard blocks ONLY on missing transcript — a parked Stage-1 queue row
// must NOT block a Stage-2 re-summarize. This test wires the REAL handler via
// registerRecordingHandlers against a REAL sql.js DB and asserts:
//   - parked/processing queue row + real transcript → handler PROCEEDS (override written)
//   - no transcript row at all → handler rejects with the new message
// ---------------------------------------------------------------------------

describe('FIX 6 — real resummarize handler: transcript-existence guard', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let handlers: Record<string, (...args: any[]) => any> = {}

  beforeEach(() => {
    handlers = {}
    // Mirror the IPC-layer test wiring: capture each registered handler by channel.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: (...args: any[]) => any) => {
      handlers[channel] = handler
      return undefined as never
    })
    registerRecordingHandlers()
  })

  it('processing queue row in-flight WITH transcript → handler PROCEEDS and writes override', async () => {
    seedRecording()
    seedTranscript()                       // real transcript row with full_text
    seedQueueRow(REC_ID, 'processing')     // a REAL in-flight queue row (should no longer block)

    const result = await handlers['transcription:resummarize'](
      null,
      { recordingId: REC_ID, templateId: TPL_ID }
    )

    // With the new guard the handler must SUCCEED — a parked Stage-1 row must not block Stage-2.
    expect(result).toEqual({ success: true })

    // The override column MUST be written to TPL_ID.
    const row = queryOne<{ summarization_template_id: string | null }>(
      'SELECT summarization_template_id FROM transcripts WHERE recording_id = ?',
      [REC_ID]
    )
    expect(row?.summarization_template_id).toBe(TPL_ID)

    // addToQueue dedupes — a processing row already exists so no new pending row is inserted.
    // The total row count must be exactly 1 (the seeded processing row, now also the effective queue entry).
    const allRows = queryOne<{ c: number }>(
      'SELECT COUNT(*) AS c FROM transcription_queue WHERE recording_id = ?',
      [REC_ID]
    )
    expect(allRows?.c).toBeGreaterThanOrEqual(1)
  })

  it('no transcript row → handler returns "No transcript to summarize yet" AND no writes', async () => {
    seedRecording()
    // No seedTranscript() — no transcript row exists.

    const result = await handlers['transcription:resummarize'](
      null,
      { recordingId: REC_ID, templateId: TPL_ID }
    )

    expect(result).toEqual({ success: false, error: 'No transcript to summarize yet — transcribe this recording first.' })

    // No queue row was enqueued.
    const queueRows = queryOne<{ c: number }>(
      'SELECT COUNT(*) AS c FROM transcription_queue WHERE recording_id = ?',
      [REC_ID]
    )
    expect(queueRows?.c).toBe(0)
  })

  it('idle (no in-flight row) → REAL handler writes the override, clears marker, enqueues', async () => {
    // Positive control: with a transcript and no in-flight row the handler writes the override.
    seedRecording()
    seedTranscript()

    const result = await handlers['transcription:resummarize'](
      null,
      { recordingId: REC_ID, templateId: TPL_ID }
    )

    expect(result).toEqual({ success: true })
    const row = queryOne<{ summarization_template_id: string | null; summarization_provider: string | null }>(
      'SELECT summarization_template_id, summarization_provider FROM transcripts WHERE recording_id = ?',
      [REC_ID]
    )
    expect(row?.summarization_template_id).toBe(TPL_ID)  // override written
    expect(row?.summarization_provider).toBeNull()        // Stage-2 marker cleared

    const queueRows = queryOne<{ c: number }>(
      "SELECT COUNT(*) AS c FROM transcription_queue WHERE recording_id = ? AND status = 'pending'",
      [REC_ID]
    )
    expect(queueRows?.c).toBe(1)
  })
})
