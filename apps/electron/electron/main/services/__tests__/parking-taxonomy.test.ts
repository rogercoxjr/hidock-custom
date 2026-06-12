/**
 * Worker taxonomy tests — auto-pipeline P4 (spec 2026-06-11 §7.1/§7.2 -> AC9).
 *
 * Uses the REAL sql.js in-memory database (same house fixture as
 * two-stage-worker.test.ts / database-v25.test.ts) so the worker's actual
 * parking writes, the runnable selection, the 24h cap, and the stage-boundary
 * parking-clear run against real schema. External boundaries (electron, config,
 * file-storage, vector-store) are mocked; the ASR/LLM provider FACTORIES are
 * mocked so each test can inject a typed ProviderRateLimitError /
 * ProviderAuthError at Stage 1 or Stage 2 and watch the worker classify it.
 *
 * All parking timestamps are asserted in SQL (datetime/julianday) — never via
 * `new Date(column)` (the space-format-vs-ISO trap; see the plan's TIMESTAMP
 * FORMAT note). The worker is driven through processQueueManually so the catch
 * block taxonomy in processQueue (NOT transcribeRecording) is the thing tested.
 */
// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'

// ---------------------------------------------------------------------------
// Hoisted shared state — real temp dir + per-test provider behavior routing.
// ---------------------------------------------------------------------------
const shared = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _os = require('os') as typeof import('os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _fs = require('fs') as typeof import('fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _path = require('path') as typeof import('path')

  const tmpDir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'hidock-parking-'))
  const dataDir = _path.join(tmpDir, 'data')
  const recordingsDir = _path.join(tmpDir, 'recordings')
  _fs.mkdirSync(dataDir, { recursive: true })
  _fs.mkdirSync(recordingsDir, { recursive: true })

  return {
    tmpDir,
    dataDir,
    recordingsDir,
    dbPath: _path.join(dataDir, 'hidock.db'),
    // Per-test provider behavior. asrBehavior/llmBehavior are functions returning
    // either a value (resolved) or a thrown error. Defaults = happy path.
    asrText: 'FULL TEXT' as string,
    asrThrow: null as Error | null,
    llmAnalysis: '' as string,
    llmThrow: null as Error | null,
    asrCalls: 0,
    llmCalls: 0,
    // Captured renderer IPC sends so a test can assert transcription:failed was
    // (not) emitted. Channel names only.
    sentChannels: [] as string[]
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
    summarization: { provider: 'gemini', ollamaCloudApiKey: '', ollamaCloudModel: '' }
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

// The provider FACTORIES are the injection point: a mocked transcribe()/generate()
// either resolves (happy path) or throws the typed error the test queued.
vi.mock('../asr/asr-provider', () => ({
  getAsrProvider: vi.fn(() => ({
    transcribe: vi.fn(async () => {
      shared.asrCalls += 1
      if (shared.asrThrow) throw shared.asrThrow
      return { text: shared.asrText, language: undefined }
    })
  }))
}))

vi.mock('../llm/llm-provider', () => ({
  getLlmProvider: vi.fn(() => ({
    generate: vi.fn(async () => {
      shared.llmCalls += 1
      if (shared.llmThrow) throw shared.llmThrow
      return shared.llmAnalysis
    })
  }))
}))

// ---------------------------------------------------------------------------
// Real service imports (resolved AFTER the mocks above).
// ---------------------------------------------------------------------------
import {
  initializeDatabase,
  closeDatabase,
  queryOne,
  run,
  addToQueue,
  getRecordingById
} from '../database'
import { processQueueManually, setMainWindowForTranscription } from '../transcription'
import { ProviderRateLimitError, ProviderAuthError } from '../provider-errors'

// ---------------------------------------------------------------------------
// Test helpers (inline raw INSERTs, no cross-service imports).
// ---------------------------------------------------------------------------

/** Insert a recordings row with a real on-disk audio file. */
function insertRecordingWithFile(id: string): string {
  const filename = `${id}.hda`
  const filePath = path.join(shared.recordingsDir, filename)
  fs.writeFileSync(filePath, Buffer.from('fake-audio-bytes'))
  run(
    `INSERT OR IGNORE INTO recordings
       (id, filename, file_path, date_recorded, status, transcription_status,
        location, on_device, on_local, created_at)
     VALUES (?, ?, ?, ?, 'complete', 'none', 'both', 1, 1, ?)`,
    [id, filename, filePath, new Date().toISOString(), new Date().toISOString()]
  )
  return filePath
}

/** A valid analysis JSON so a happy-path Stage 2 completes. */
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

/** Fake renderer window: captures the channels the worker sends. */
function installFakeWindow(): void {
  setMainWindowForTranscription({
    isDestroyed: () => false,
    webContents: {
      send: (channel: string) => {
        shared.sentChannels.push(channel)
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('worker taxonomy — parking + 24h cap + auth/quota (auto-pipeline P4, spec §7)', () => {
  beforeEach(async () => {
    fs.mkdirSync(shared.dataDir, { recursive: true })
    fs.mkdirSync(shared.recordingsDir, { recursive: true })
    if (fs.existsSync(shared.dbPath)) fs.rmSync(shared.dbPath)
    shared.asrText = 'FULL TEXT'
    shared.asrThrow = null
    shared.llmAnalysis = validAnalysisJson()
    shared.llmThrow = null
    shared.asrCalls = 0
    shared.llmCalls = 0
    shared.sentChannels = []
    vi.clearAllMocks()
    await initializeDatabase()
    installFakeWindow()
  })

  afterEach(() => {
    try {
      closeDatabase()
    } catch {
      /* ignore */
    }
  })

  // -------------------------------------------------------------------------
  // Test 1: 429 (retryAfter set) -> park, not fail. (spec §7.2, AC9)
  // -------------------------------------------------------------------------
  it('ProviderRateLimitError (retryAfter 120s) parks the item: pending + parked_until≈now+120s + first_parked_at set, retry_count untouched, recording NOT error, no transcription:failed', async () => {
    insertRecordingWithFile('rec-park-1')
    const id = addToQueue('rec-park-1')
    // Seed retry_count via raw SQL so we can prove parking does NOT bump it.
    run("UPDATE transcription_queue SET retry_count = 2 WHERE id = ?", [id])
    // ASR throws a parkable 429 with a 120s Retry-After.
    shared.asrThrow = new ProviderRateLimitError('Ollama Cloud', 120_000)

    await processQueueManually()

    // All timestamp assertions in SQL.
    const r = queryOne<{
      status: string
      retry_count: number
      parked_until_ok: number
      first_parked_at_ok: number
    }>(
      `SELECT status, retry_count,
              (datetime(parked_until) > datetime('now') AND
               datetime(parked_until) <= datetime('now', '+121 seconds')) AS parked_until_ok,
              (first_parked_at IS NOT NULL) AS first_parked_at_ok
       FROM transcription_queue WHERE id = ?`,
      [id]
    )
    expect(r?.status).toBe('pending') // parked = still pending (no new status value)
    expect(r?.retry_count).toBe(2) // UNCHANGED — parking bypasses the increment
    expect(r?.parked_until_ok).toBe(1)
    expect(r?.first_parked_at_ok).toBe(1)
    // Recording stays out of the 'error' state — parking is silent.
    expect(getRecordingById('rec-park-1')!.transcription_status).toBe('pending')
    // The failure chip counts FAILED rows only; parking must NOT emit failed.
    expect(shared.sentChannels).not.toContain('transcription:failed')
  })

  // -------------------------------------------------------------------------
  // Test 2: 429 with NO retryAfter -> 30 min default. (spec §7.2)
  // -------------------------------------------------------------------------
  it('ProviderRateLimitError without retryAfter parks for the 30-minute default', async () => {
    insertRecordingWithFile('rec-park-2')
    const id = addToQueue('rec-park-2')
    shared.asrThrow = new ProviderRateLimitError('Ollama Cloud') // no retryAfterMs

    await processQueueManually()

    const r = queryOne<{ status: string; default_window_ok: number }>(
      `SELECT status,
              (datetime(parked_until) > datetime('now', '+29 minutes') AND
               datetime(parked_until) <= datetime('now', '+31 minutes')) AS default_window_ok
       FROM transcription_queue WHERE id = ?`,
      [id]
    )
    expect(r?.status).toBe('pending')
    expect(r?.default_window_ok).toBe(1) // ~30 min
  })

  // -------------------------------------------------------------------------
  // Test 3: parked item skipped by the next tick, runs once parked_until passes. (AC9)
  // -------------------------------------------------------------------------
  it('a parked item is invisible to the next processQueue tick but runs once parked_until is in the past', async () => {
    insertRecordingWithFile('rec-park-3')
    const id = addToQueue('rec-park-3')
    shared.asrThrow = new ProviderRateLimitError('Ollama Cloud', 60_000)

    // First tick: parks the item.
    await processQueueManually()
    const asrAfterPark = shared.asrCalls
    expect(asrAfterPark).toBe(1)

    // Second tick while still parked: the runnable selection must skip it (no
    // additional ASR call).
    shared.asrThrow = null // would succeed if it ran — but it must NOT run yet
    await processQueueManually()
    expect(shared.asrCalls).toBe(asrAfterPark) // unchanged — still parked

    // Simulate the park expiring (seed parked_until into the past, space-format).
    run("UPDATE transcription_queue SET parked_until = datetime('now', '-10 seconds') WHERE id = ?", [id])
    shared.asrText = 'RESUMED TEXT'
    shared.llmAnalysis = validAnalysisJson()

    await processQueueManually()
    expect(shared.asrCalls).toBe(asrAfterPark + 1) // park expired -> it ran
    expect(getRecordingById('rec-park-3')!.transcription_status).toBe('complete')
    const done = queryOne<{ status: string }>('SELECT status FROM transcription_queue WHERE id = ?', [id])
    expect(done?.status).toBe('completed')
  })

  // -------------------------------------------------------------------------
  // Test 4: 429 when first_parked_at is older than 24h -> terminal. (spec §7.1, AC9)
  // -------------------------------------------------------------------------
  it('a 429 arriving when first_parked_at is >24h old terminal-fails with the §7.1 quota-after-24h message', async () => {
    insertRecordingWithFile('rec-park-4')
    const id = addToQueue('rec-park-4')
    // Seed an already-parked item whose first_parked_at is 25h old (space-format UTC).
    run(
      "UPDATE transcription_queue SET parked_until = datetime('now', '-1 hour'), first_parked_at = datetime('now', '-25 hours') WHERE id = ?",
      [id]
    )
    // The next attempt hits another 429.
    shared.asrThrow = new ProviderRateLimitError('Ollama Cloud', 120_000)

    await processQueueManually()

    const r = queryOne<{ status: string; error_message: string }>(
      'SELECT status, error_message FROM transcription_queue WHERE id = ?',
      [id]
    )
    expect(r?.status).toBe('failed') // terminal — 24h cap exceeded
    expect(r?.error_message).toContain('quota still exhausted after 24h')
    expect(r?.error_message).toBe('Ollama Cloud quota still exhausted after 24h — check your plan, then Retry all')
    expect(getRecordingById('rec-park-4')!.transcription_status).toBe('error')
    expect(shared.sentChannels).toContain('transcription:failed')
  })

  // -------------------------------------------------------------------------
  // Test 5: ProviderAuthError -> terminal failed immediately. (spec §7.1)
  // -------------------------------------------------------------------------
  it('ProviderAuthError terminal-fails immediately (message matches NON_RETRYABLE "API key was rejected") and is not re-pended', async () => {
    insertRecordingWithFile('rec-auth-1')
    const id = addToQueue('rec-auth-1')
    shared.asrThrow = new ProviderAuthError('OpenAI')

    await processQueueManually()

    const r = queryOne<{ status: string; error_message: string; retry_count: number }>(
      'SELECT status, error_message, retry_count FROM transcription_queue WHERE id = ?',
      [id]
    )
    expect(r?.status).toBe('failed')
    expect(r?.error_message).toContain('API key was rejected')
    expect(getRecordingById('rec-auth-1')!.transcription_status).toBe('error')

    // A subsequent tick must NOT re-pend it (the message is in NON_RETRYABLE).
    const callsBefore = shared.asrCalls
    await processQueueManually()
    expect(shared.asrCalls).toBe(callsBefore) // not retried
    const still = queryOne<{ status: string }>('SELECT status FROM transcription_queue WHERE id = ?', [id])
    expect(still?.status).toBe('failed')
  })

  // -------------------------------------------------------------------------
  // Test 6: parking clears on STAGE completion. (spec §7.2)
  // -------------------------------------------------------------------------
  it('a Stage-1 park is wiped at the Stage-2 boundary so a Stage-2 429 gets a FRESH first_parked_at (no 24h poisoning)', async () => {
    insertRecordingWithFile('rec-stage-1')
    const id = addToQueue('rec-stage-1')
    // Seed a Stage-1 park history that is ALREADY ~25h old. If the stage-boundary
    // clear did not run, the Stage-2 429 below would inherit this >24h clock and
    // terminal-fail instead of parking fresh.
    run(
      "UPDATE transcription_queue SET parked_until = datetime('now', '-1 hour'), first_parked_at = datetime('now', '-25 hours') WHERE id = ?",
      [id]
    )
    // Stage 1 (ASR) SUCCEEDS — its progressCallback('analyzing') must clear parking.
    shared.asrThrow = null
    shared.asrText = 'STAGE ONE OK'
    // Stage 2 (LLM analysis) throws a fresh 429.
    shared.llmThrow = new ProviderRateLimitError('Ollama Cloud', 120_000)

    await processQueueManually()

    // The new park must be fresh: first_parked_at is ~now (NOT ~25h old) and the
    // item is parked (pending), not 24h-terminal-failed.
    const r = queryOne<{ status: string; fresh_age_ok: number }>(
      `SELECT status,
              ((julianday('now') - julianday(first_parked_at)) * 24.0 < 1.0) AS fresh_age_ok
       FROM transcription_queue WHERE id = ?`,
      [id]
    )
    expect(r?.status).toBe('pending') // parked fresh, not terminal
    expect(r?.fresh_age_ok).toBe(1) // first_parked_at reset to ~now by the stage clear
  })

  it('full success clears both parking columns (parked_until + first_parked_at NULL)', async () => {
    insertRecordingWithFile('rec-stage-2')
    const id = addToQueue('rec-stage-2')
    // Pre-seed a park history (e.g. earlier 429 that has since expired).
    run(
      "UPDATE transcription_queue SET parked_until = datetime('now', '-5 minutes'), first_parked_at = datetime('now', '-1 hour') WHERE id = ?",
      [id]
    )
    shared.asrThrow = null
    shared.asrText = 'OK TEXT'
    shared.llmThrow = null
    shared.llmAnalysis = validAnalysisJson()

    await processQueueManually()

    const r = queryOne<{ status: string; parked_until: string | null; first_parked_at: string | null }>(
      'SELECT status, parked_until, first_parked_at FROM transcription_queue WHERE id = ?',
      [id]
    )
    expect(r?.status).toBe('completed')
    expect(r?.parked_until).toBeNull()
    expect(r?.first_parked_at).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Test 7: restart persistence. (AC9)
  // -------------------------------------------------------------------------
  it('parking state survives an app restart (close/reopen the DB) and the runnable filter still honors it', async () => {
    insertRecordingWithFile('rec-restart-1')
    const id = addToQueue('rec-restart-1')
    shared.asrThrow = new ProviderRateLimitError('Ollama Cloud', 3600_000) // 1h park

    await processQueueManually()
    // Confirm parked before restart.
    const before = queryOne<{ status: string; parked_until: string | null; first_parked_at: string | null }>(
      'SELECT status, parked_until, first_parked_at FROM transcription_queue WHERE id = ?',
      [id]
    )
    expect(before?.status).toBe('pending')
    expect(before?.parked_until).not.toBeNull()
    expect(before?.first_parked_at).not.toBeNull()

    // Restart: persist + reopen against the SAME db file (migration-test idiom).
    closeDatabase()
    await initializeDatabase()
    installFakeWindow()

    // Columns survived.
    const after = queryOne<{ parked_until_future: number; first_parked_at_ok: number }>(
      `SELECT (datetime(parked_until) > datetime('now')) AS parked_until_future,
              (first_parked_at IS NOT NULL) AS first_parked_at_ok
       FROM transcription_queue WHERE id = ?`,
      [id]
    )
    expect(after?.parked_until_future).toBe(1)
    expect(after?.first_parked_at_ok).toBe(1)

    // The runnable filter still excludes it (it would succeed now if it ran).
    shared.asrThrow = null
    const callsBefore = shared.asrCalls
    await processQueueManually()
    expect(shared.asrCalls).toBe(callsBefore) // still parked after restart
  })
})

afterAll(() => {
  try {
    fs.rmSync(shared.tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore — Windows can hold handles briefly */
  }
})
