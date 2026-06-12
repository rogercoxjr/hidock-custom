/**
 * Schema v25 tests — auto-pipeline P1 (spec 2026-06-11 §5.8)
 *
 * Uses the REAL sql.js in-memory database (same pattern as e2e-smoke.test.ts):
 * only external boundaries (electron, config, file-storage, vector-store) are
 * mocked; sql.js, fs, and database.ts run their real implementations.
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

  const tmpDir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'hidock-v25-'))
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
  updateTranscriptStage2,
  clearTranscriptStage2Marker,
  addToQueue,
  updateQueueItem,
  parkQueueItem,
  getRunnableQueueItems,
  clearParking,
  getQueueItemParkedHours,
  rependFailedItems
} from '../database'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Insert a minimal recording row so transcript FK constraints pass.
 * Mirrors the approach used in e2e-smoke (upsertRecordingFromDevice) but
 * inlined here so this file has no cross-service imports.
 */
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

describe('schema v25 (auto-pipeline P1)', () => {
  beforeEach(async () => {
    // Ensure fresh dirs and no stale DB file for each test.
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

  it('fresh boot has the four new columns', () => {
    const tCols = queryAll<{ name: string }>("SELECT name FROM pragma_table_info('transcripts')").map(c => c.name)
    expect(tCols).toContain('summarization_provider')
    expect(tCols).toContain('summarization_model')
    const qCols = queryAll<{ name: string }>(
      "SELECT name FROM pragma_table_info('transcription_queue')"
    ).map(c => c.name)
    expect(qCols).toContain('parked_until')
    expect(qCols).toContain('first_parked_at')
  })

  it('fresh boot has sync_baseline_files', () => {
    const t = queryOne<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='sync_baseline_files'"
    )
    expect(t?.name).toBe('sync_baseline_files')
  })

  it('backfill marks fused-flow rows complete but leaves NULL-summary rows resumable', async () => {
    // Genuine upgrade-path test: seed legacy-shaped rows, rewind the recorded
    // schema version to 24, then re-init against the SAME db file so the REAL
    // MIGRATIONS[25] (including its actual backfill UPDATE) executes — no
    // hand-copied SQL that could drift from the migration.
    insertTestRecording('rec_legacy_ok')
    insertTestRecording('rec_legacy_null')
    run(`INSERT INTO transcripts (id, recording_id, full_text, language, summary, transcription_model)
         VALUES ('trans_rec_legacy_ok', 'rec_legacy_ok', 'text', 'en', 'a real summary', 'gemini-2.0-flash-exp')`)
    run(`INSERT INTO transcripts (id, recording_id, full_text, language, summary, transcription_model)
         VALUES ('trans_rec_legacy_null', 'rec_legacy_null', 'text', 'en', NULL, 'gemini-2.0-flash-exp')`)

    // Rewind to v24 and force a re-migration. run() persists each statement to
    // disk and closeDatabase() saves again, so the re-init below loads this state.
    run('DELETE FROM schema_version')
    run('INSERT INTO schema_version (version) VALUES (24)')
    closeDatabase()
    await initializeDatabase()

    const ok = queryOne<{ summarization_provider: string }>(
      "SELECT summarization_provider FROM transcripts WHERE recording_id='rec_legacy_ok'")
    const nul = queryOne<{ summarization_provider: string | null }>(
      "SELECT summarization_provider FROM transcripts WHERE recording_id='rec_legacy_null'")
    expect(ok?.summarization_provider).toBe('gemini')
    expect(nul?.summarization_provider).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Task 2: Stage-write functions
// ---------------------------------------------------------------------------

describe('stage-write functions', () => {
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

  it('upsertTranscriptStage1 inserts and never touches Stage-2 columns on conflict', () => {
    insertTestRecording('rec_s1')
    upsertTranscriptStage1({
      recording_id: 'rec_s1', full_text: 'v1 text', language: undefined,
      word_count: 2, transcription_provider: 'gemini', transcription_model: 'gemini-2.0-flash-exp'
    })
    // Simulate Stage 2 having completed:
    run(`UPDATE transcripts SET summary='S', summarization_provider='gemini' WHERE recording_id='rec_s1'`)
    // A re-run of Stage 1 (e.g. explicit re-transcribe) must keep Stage-2 columns intact:
    upsertTranscriptStage1({
      recording_id: 'rec_s1', full_text: 'v2 text', language: 'en',
      word_count: 2, transcription_provider: 'gemini', transcription_model: 'gemini-2.0-flash-exp'
    })
    const row = queryOne<{ full_text: string; summary: string; summarization_provider: string; id: string }>(
      "SELECT id, full_text, summary, summarization_provider FROM transcripts WHERE recording_id='rec_s1'")
    expect(row?.full_text).toBe('v2 text')
    expect(row?.summary).toBe('S')                       // untouched
    expect(row?.summarization_provider).toBe('gemini')   // untouched
    expect(row?.id).toBe('trans_rec_s1')                 // id rule preserved
  })

  it('updateTranscriptStage2 writes content + marker atomically and COALESCEs language', () => {
    insertTestRecording('rec_s2')
    upsertTranscriptStage1({
      recording_id: 'rec_s2', full_text: 'hello world', language: undefined,
      word_count: 2, transcription_provider: 'gemini', transcription_model: 'm'
    })
    updateTranscriptStage2('rec_s2', {
      summary: 'sum', action_items: '["a"]', topics: '["t"]', key_points: '["k"]',
      title_suggestion: 'Title', question_suggestions: '["q?"]', language: 'en',
      summarization_provider: 'gemini', summarization_model: 'm'
    })
    const row = queryOne<Record<string, string>>("SELECT * FROM transcripts WHERE recording_id='rec_s2'")
    expect(row?.summary).toBe('sum')
    expect(row?.summarization_provider).toBe('gemini')
    expect(row?.language).toBe('en')   // was NULL from Stage 1 -> analysis language wins
  })

  it('updateTranscriptStage2 does not overwrite an ASR-provided language', () => {
    insertTestRecording('rec_s3')
    upsertTranscriptStage1({
      recording_id: 'rec_s3', full_text: 'hola', language: 'es',
      word_count: 1, transcription_provider: 'openai-whisper', transcription_model: 'whisper-1'
    })
    updateTranscriptStage2('rec_s3', {
      summary: 's', language: 'en', summarization_provider: 'gemini', summarization_model: 'm'
    })
    const row = queryOne<{ language: string }>("SELECT language FROM transcripts WHERE recording_id='rec_s3'")
    expect(row?.language).toBe('es')   // COALESCE keeps the ASR value
  })
})

// ---------------------------------------------------------------------------
// Task 4 (auto-pipeline P3, spec §5.3): clearTranscriptStage2Marker
// ---------------------------------------------------------------------------

describe('clearTranscriptStage2Marker (spec §5.3)', () => {
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

  it('NULLs only the stage marker columns and leaves summary + other analysis columns untouched', () => {
    insertTestRecording('rec_clr')
    upsertTranscriptStage1({
      recording_id: 'rec_clr', full_text: 'kept text', language: 'en',
      word_count: 2, transcription_provider: 'gemini', transcription_model: 'm'
    })
    updateTranscriptStage2('rec_clr', {
      summary: 'kept summary', action_items: '["a"]', topics: '["t"]', key_points: '["k"]',
      title_suggestion: 'Kept Title', question_suggestions: '["q?"]', language: 'en',
      summarization_provider: 'gemini', summarization_model: 'm'
    })

    clearTranscriptStage2Marker('rec_clr')

    const row = queryOne<Record<string, string | null>>(
      "SELECT * FROM transcripts WHERE recording_id='rec_clr'")
    // ONLY the stage marker is cleared:
    expect(row?.summarization_provider).toBeNull()
    expect(row?.summarization_model).toBeNull()
    // Everything else survives (the old summary must NOT be lost):
    expect(row?.full_text).toBe('kept text')
    expect(row?.summary).toBe('kept summary')
    expect(row?.action_items).toBe('["a"]')
    expect(row?.topics).toBe('["t"]')
    expect(row?.key_points).toBe('["k"]')
    expect(row?.title_suggestion).toBe('Kept Title')
    expect(row?.question_suggestions).toBe('["q?"]')
  })

  it('throws when no transcript row exists for the recording (consistent with updateTranscriptStage2)', () => {
    expect(() => clearTranscriptStage2Marker('rec_missing')).toThrow(
      /no transcript row for recording rec_missing/
    )
  })
})

// ---------------------------------------------------------------------------
// Task 5: addToQueue dedupe (spec §5.7)
// ---------------------------------------------------------------------------

describe('addToQueue dedupe (spec §5.7)', () => {
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

  it('returns the existing pending item id instead of inserting a duplicate', () => {
    insertTestRecording('rec_q1')
    const first = addToQueue('rec_q1')
    const second = addToQueue('rec_q1')
    expect(second).toBe(first)   // truthy + identical (return contract)
    const rows = queryAll("SELECT id FROM transcription_queue WHERE recording_id='rec_q1'")
    expect(rows.length).toBe(1)
  })

  it('allows a new item once the prior one is terminal', () => {
    insertTestRecording('rec_q2')
    const first = addToQueue('rec_q2')
    updateQueueItem(first, 'completed')
    const second = addToQueue('rec_q2')
    expect(second).toBeTruthy()
    expect(second).not.toBe(first)
  })
})

// ---------------------------------------------------------------------------
// Task 1 (auto-pipeline P4): Parking DB primitives (spec §7.2)
// ---------------------------------------------------------------------------

describe('parking DB primitives (auto-pipeline P4)', () => {
  // Shared setup/teardown — fresh DB per test
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

  // Helper: insert a queue item with a specific status and retry_count
  function insertQueueItem(id: string, recId: string, status = 'pending', retryCount = 0): void {
    insertTestRecording(recId)
    run(
      `INSERT INTO transcription_queue (id, recording_id, status, retry_count)
       VALUES (?, ?, ?, ?)`,
      [id, recId, status, retryCount]
    )
  }

  // -------------------------------------------------------------------------
  // parkQueueItem
  // -------------------------------------------------------------------------

  it('parkQueueItem: status stays pending, parked_until is in the future, first_parked_at is set, retry_count unchanged', () => {
    insertQueueItem('q-park-1', 'rec-park-1', 'pending', 2)
    parkQueueItem('q-park-1', 120_000) // 120 seconds

    // All timestamp assertions done in SQL — never parse column values in JS
    const r = queryOne<{ status: string; retry_count: number; parked_until_ok: number; first_parked_at_ok: number }>(
      `SELECT status, retry_count,
              (datetime(parked_until) > datetime('now') AND
               datetime(parked_until) <= datetime('now', '+121 seconds')) AS parked_until_ok,
              (first_parked_at IS NOT NULL) AS first_parked_at_ok
       FROM transcription_queue WHERE id = 'q-park-1'`
    )
    expect(r?.status).toBe('pending')
    expect(r?.retry_count).toBe(2)            // UNCHANGED
    expect(r?.parked_until_ok).toBe(1)        // within next 121 s
    expect(r?.first_parked_at_ok).toBe(1)     // set to ~now
  })

  it('parkQueueItem: re-park updates parked_until but keeps original first_parked_at (COALESCE)', () => {
    insertQueueItem('q-park-2', 'rec-park-2')
    parkQueueItem('q-park-2', 60_000)

    // Backdate first_parked_at by 1 hour via raw SQL. CURRENT_TIMESTAMP has only
    // 1-second resolution, so a same-second re-park would string-equal the original
    // even if COALESCE were removed — the test could not detect loss of the behavior
    // it guards (first_parked_at survival anchors the 24h terminal cap, spec §7.2).
    // Seeding into the past makes a regression observable: without COALESCE the
    // second park would overwrite first_parked_at with ~now, collapsing the age to 0.
    run(`UPDATE transcription_queue SET first_parked_at = datetime('now', '-1 hour') WHERE id = 'q-park-2'`)

    parkQueueItem('q-park-2', 300_000) // second park — longer delay

    // All assertions in SQL (julianday) — never parse the space-format timestamp in JS.
    const afterSecond = queryOne<{ first_parked_at_age_ok: number; parked_until_future: number }>(
      `SELECT (first_parked_at IS NOT NULL
               AND (julianday('now') - julianday(first_parked_at)) * 24.0 BETWEEN 0.95 AND 1.05)
                AS first_parked_at_age_ok,
              (datetime(parked_until) > datetime('now', '+250 seconds')) AS parked_until_future
       FROM transcription_queue WHERE id = 'q-park-2'`
    )
    // first_parked_at must still be ~1h old (COALESCE preserved the backdated value)
    expect(afterSecond?.first_parked_at_age_ok).toBe(1)
    // parked_until was updated to the longer delay
    expect(afterSecond?.parked_until_future).toBe(1)
  })

  // -------------------------------------------------------------------------
  // getRunnableQueueItems
  // -------------------------------------------------------------------------

  it('getRunnableQueueItems: returns pending rows with NULL parked_until', () => {
    insertQueueItem('q-run-1', 'rec-run-1', 'pending', 0)
    const items = getRunnableQueueItems()
    expect(items.some(i => i.id === 'q-run-1')).toBe(true)
  })

  it('getRunnableQueueItems: EXCLUDES rows parked into the future (format regression test)', () => {
    // This is the lexicographic-format regression test:
    // parkQueueItem uses datetime('now', '+Ns') which produces the space-separated format
    // e.g. "2026-06-12 18:30:00". The SQL comparison must work correctly on the SAME DAY
    // it is parked (the bug: JS toISOString() produces "2026-06-12T18:30:00.000Z" which
    // sorts GREATER than same-day space-format timestamps).
    insertQueueItem('q-run-2', 'rec-run-2', 'pending', 0)
    parkQueueItem('q-run-2', 60_000) // parked 60s into future

    const items = getRunnableQueueItems()
    expect(items.some(i => i.id === 'q-run-2')).toBe(false) // EXCLUDED while parked
  })

  it('getRunnableQueueItems: INCLUDES rows whose parked_until is in the past (park expiry = runnable)', () => {
    insertQueueItem('q-run-3', 'rec-run-3', 'pending', 0)
    // Seed via raw SQL with a past timestamp (space-format, SQLite style)
    run(`UPDATE transcription_queue SET parked_until = datetime('now', '-10 seconds') WHERE id = 'q-run-3'`)

    const items = getRunnableQueueItems()
    expect(items.some(i => i.id === 'q-run-3')).toBe(true) // park expired → runnable
  })

  it('getRunnableQueueItems: does not return non-pending items', () => {
    insertQueueItem('q-run-4', 'rec-run-4', 'failed', 3)
    const items = getRunnableQueueItems()
    expect(items.some(i => i.id === 'q-run-4')).toBe(false)
  })

  // -------------------------------------------------------------------------
  // clearParking
  // -------------------------------------------------------------------------

  it('clearParking: nulls both parked_until and first_parked_at', () => {
    insertQueueItem('q-clr-1', 'rec-clr-1')
    parkQueueItem('q-clr-1', 60_000)

    clearParking('q-clr-1')

    const r = queryOne<{ parked_until: string | null; first_parked_at: string | null }>(
      `SELECT parked_until, first_parked_at FROM transcription_queue WHERE id = 'q-clr-1'`
    )
    expect(r?.parked_until).toBeNull()
    expect(r?.first_parked_at).toBeNull()
  })

  // -------------------------------------------------------------------------
  // getQueueItemParkedHours
  // -------------------------------------------------------------------------

  it('getQueueItemParkedHours: returns null when first_parked_at is NULL', () => {
    insertQueueItem('q-hrs-1', 'rec-hrs-1')
    expect(getQueueItemParkedHours('q-hrs-1')).toBeNull()
  })

  it('getQueueItemParkedHours: returns ~25 hours when first_parked_at is 25h ago (SQL julianday, not JS Date)', () => {
    insertQueueItem('q-hrs-2', 'rec-hrs-2')
    // Seed via raw SQL — 25 hours ago in space-separated UTC format
    run(`UPDATE transcription_queue SET first_parked_at = datetime('now', '-25 hours') WHERE id = 'q-hrs-2'`)

    const hours = getQueueItemParkedHours('q-hrs-2')
    expect(hours).not.toBeNull()
    // julianday arithmetic is always UTC, so this must read ≈25 regardless of local TZ
    expect(hours!).toBeGreaterThan(24.9)
    expect(hours!).toBeLessThan(25.1)
  })

  // -------------------------------------------------------------------------
  // rependFailedItems
  // -------------------------------------------------------------------------

  it('rependFailedItems: re-pends failed rows matching ANY marker, returns count', () => {
    insertTestRecording('rec-rpnd-1')
    insertTestRecording('rec-rpnd-2')
    insertTestRecording('rec-rpnd-3')

    // Insert failed items
    run(`INSERT INTO transcription_queue (id, recording_id, status, retry_count, error_message)
         VALUES ('q-rpnd-1', 'rec-rpnd-1', 'failed', 3, 'OpenAI API key was rejected — re-enter it in Settings')`)
    run(`INSERT INTO transcription_queue (id, recording_id, status, retry_count, error_message)
         VALUES ('q-rpnd-2', 'rec-rpnd-2', 'failed', 3, 'Gemini API key not configured. Please add your API key in Settings.')`)
    run(`INSERT INTO transcription_queue (id, recording_id, status, retry_count, parked_until, first_parked_at, error_message)
         VALUES ('q-rpnd-3', 'rec-rpnd-3', 'failed', 3, datetime('now', '-1 hour'), datetime('now', '-2 hours'),
                 'Ollama Cloud quota still exhausted after 24h — check your plan, then Retry all')`)

    const count = rependFailedItems(['OpenAI', 'Gemini API key', 'Ollama Cloud'])
    expect(count).toBe(3)

    const rows = queryAll<{ id: string; status: string; retry_count: number; parked_until: string | null; first_parked_at: string | null }>(
      `SELECT id, status, retry_count, parked_until, first_parked_at FROM transcription_queue
       WHERE id IN ('q-rpnd-1', 'q-rpnd-2', 'q-rpnd-3')`
    )
    for (const row of rows) {
      expect(row.status).toBe('pending')
      expect(row.retry_count).toBe(0)
      expect(row.parked_until).toBeNull()
      expect(row.first_parked_at).toBeNull()
    }
  })

  it('rependFailedItems: leaves non-matching failed rows untouched', () => {
    insertTestRecording('rec-rpnd-4')
    run(`INSERT INTO transcription_queue (id, recording_id, status, retry_count, error_message)
         VALUES ('q-rpnd-4', 'rec-rpnd-4', 'failed', 3, 'Recording file not found: /path/to/file.hda')`)

    const count = rependFailedItems(['OpenAI', 'Gemini API key', 'Ollama Cloud'])
    expect(count).toBe(0)

    const row = queryOne<{ status: string }>(`SELECT status FROM transcription_queue WHERE id = 'q-rpnd-4'`)
    expect(row?.status).toBe('failed') // untouched
  })

  it('rependFailedItems: returns 0 for empty marker array', () => {
    insertTestRecording('rec-rpnd-5')
    run(`INSERT INTO transcription_queue (id, recording_id, status, error_message)
         VALUES ('q-rpnd-5', 'rec-rpnd-5', 'failed', 'OpenAI key rejected')`)
    expect(rependFailedItems([])).toBe(0)
  })

  it('rependFailedItems: also resets recording transcription_status to pending', () => {
    insertTestRecording('rec-rpnd-6')
    run(`UPDATE recordings SET transcription_status = 'error' WHERE id = 'rec-rpnd-6'`)
    run(`INSERT INTO transcription_queue (id, recording_id, status, retry_count, error_message)
         VALUES ('q-rpnd-6', 'rec-rpnd-6', 'failed', 3, 'OpenAI API key was rejected')`)

    rependFailedItems(['OpenAI'])

    const rec = queryOne<{ transcription_status: string }>(`SELECT transcription_status FROM recordings WHERE id = 'rec-rpnd-6'`)
    expect(rec?.transcription_status).toBe('pending')
  })

  it('rependFailedItems: LIKE-injection safety — percent in marker is treated literally, not as a wildcard', () => {
    // The seeded error_message matches the UNescaped pattern (%100% quota% → '100' … ' quota')
    // but NOT the escaped pattern (%100\% quota% → literal '100% quota' substring).
    // If escapeLikePattern were stripped, the '%' in the marker would act as a wildcard and
    // re-pend this row; with escaping it must stay 'failed'. This mutation-kills the test.
    insertTestRecording('rec-rpnd-7')
    run(`INSERT INTO transcription_queue (id, recording_id, status, error_message)
         VALUES ('q-rpnd-7', 'rec-rpnd-7', 'failed', 'Error 100: insufficient quota')`)

    // Marker contains a literal percent; the row does NOT contain the literal substring '100% quota'.
    const count = rependFailedItems(['100% quota'])
    expect(count).toBe(0) // percent escaped → no wildcard match
    const row = queryOne<{ status: string }>(`SELECT status FROM transcription_queue WHERE id = 'q-rpnd-7'`)
    expect(row?.status).toBe('failed') // unmatched — untouched
  })
})
