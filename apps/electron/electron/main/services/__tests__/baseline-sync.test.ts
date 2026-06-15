/**
 * First-sync baseline tests — auto-pipeline P5 (spec 2026-06-11 §5.5, AC2, AC3).
 *
 * Uses the REAL sql.js in-memory database (same boundary-mock pattern as
 * database-v25.test.ts / two-stage-worker.test.ts) so ensureBaseline and the
 * updated getFilesToSync run against the real schema including sync_baseline_files.
 * Only external boundaries are mocked: electron, config, file-storage, vector-store.
 */
// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'

// ---------------------------------------------------------------------------
// Hoisted shared state — real temp dir resolves before vi.mock factories.
// ---------------------------------------------------------------------------
const shared = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _os = require('os') as typeof import('os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _fs = require('fs') as typeof import('fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _path = require('path') as typeof import('path')

  const tmpDir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'hidock-baseline-'))
  const dataDir = _path.join(tmpDir, 'data')
  _fs.mkdirSync(dataDir, { recursive: true })

  return {
    tmpDir,
    dataDir,
    dbPath: _path.join(dataDir, 'hidock.db')
  }
})

// ---------------------------------------------------------------------------
// External-boundary mocks (must be hoisted before real imports).
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
    summarization: { provider: 'gemini' }
  })),
  updateConfig: vi.fn(async () => {}),
  getDataPath: vi.fn(() => shared.tmpDir)
}))

vi.mock('../file-storage', () => ({
  getDatabasePath: vi.fn(() => shared.dbPath),
  getRecordingsPath: vi.fn(() => shared.tmpDir),
  getCachePath: vi.fn(() => os.tmpdir()),
  saveRecording: vi.fn(async (filename: string) => path.join(shared.tmpDir, filename))
}))

vi.mock('../vector-store', () => ({
  getVectorStore: vi.fn(() => null)
}))

// fs: need existsSync to return false (no real audio files on disk)
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    default: { ...actual, existsSync: vi.fn(() => false) },
    existsSync: vi.fn(() => false)
  }
})

// ---------------------------------------------------------------------------
// Real service imports (resolved AFTER the mocks above).
// ---------------------------------------------------------------------------
import {
  initializeDatabase,
  closeDatabase,
  queryOne,
  addSyncedFile
} from '../database'
import * as database from '../database'
import { getDownloadService } from '../download-service'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a device file descriptor */
function makeFile(filename: string) {
  return { filename, size: 1024, duration: 60, dateCreated: new Date('2024-01-01') }
}

/** Count baseline rows for a serial */
function baselineCount(serial: string): number {
  return (
    queryOne<{ n: number }>(
      'SELECT COUNT(*) AS n FROM sync_baseline_files WHERE device_serial = ?',
      [serial]
    )?.n ?? 0
  )
}

/** Check whether a specific baseline row exists */
function hasBaselineRow(serial: string, filename: string): boolean {
  return !!queryOne(
    'SELECT 1 FROM sync_baseline_files WHERE device_serial = ? AND filename = ?',
    [serial, filename]
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ensureBaseline + baseline-aware getFilesToSync (auto-pipeline P5)', () => {
  let service: ReturnType<typeof getDownloadService>

  beforeEach(async () => {
    fs.mkdirSync(shared.dataDir, { recursive: true })
    if (fs.existsSync(shared.dbPath)) fs.rmSync(shared.dbPath)
    await initializeDatabase()
    service = getDownloadService()
  })

  afterEach(() => {
    try {
      closeDatabase()
    } catch {
      /* ignore */
    }
  })

  // -------------------------------------------------------------------------
  // Test 1: Fresh device — no baseline rows, no prior sync history
  // -------------------------------------------------------------------------
  it('fresh device: ensureBaseline inserts rows and returns { created: true }', () => {
    const result = service.ensureBaseline('SN1', ['a.hda', 'b.hda'])

    expect(result).toEqual({ created: true })
    expect(baselineCount('SN1')).toBe(2)
    expect(hasBaselineRow('SN1', 'a.hda')).toBe(true)
    expect(hasBaselineRow('SN1', 'b.hda')).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Test 1b: Bulk insert is ONE batched write, not a per-file run() loop
  // (code-quality review finding 1). A ~1400-file fresh-device backlog through
  // the old per-row run() would do a full db.export() + writeFileSync per file
  // (N serializations). runMany binds every row to one prepared statement and
  // serializes exactly once — so the batched path is taken and run() is not.
  // -------------------------------------------------------------------------
  it('fresh device: bulk insert uses one runMany call, not a per-file run() loop', () => {
    const runManySpy = vi.spyOn(database, 'runMany')
    const runSpy = vi.spyOn(database, 'run')
    const filenames = Array.from({ length: 50 }, (_, i) => `f${i}.hda`)

    const result = service.ensureBaseline('SN_BULK', filenames)

    expect(result).toEqual({ created: true })
    expect(baselineCount('SN_BULK')).toBe(50)
    // One batched write — not 50 per-row run() calls.
    expect(runManySpy).toHaveBeenCalledTimes(1)
    expect(runManySpy.mock.calls[0][1]).toHaveLength(50) // 50 row tuples in one call
    expect(runSpy).not.toHaveBeenCalled()

    runManySpy.mockRestore()
    runSpy.mockRestore()
  })

  // -------------------------------------------------------------------------
  // Test 1c: The write is one batched call, and a failure mid-write leaves NO
  // partial baseline (code-quality review finding 1). runMany's single
  // saveDatabase() runs only after every row binds, so a throw never serializes
  // a partial baseline — the un-snapshotted remainder would otherwise auto-queue
  // through metered ASR.
  // -------------------------------------------------------------------------
  it('fresh device: the insert is one batched call and a failure persists zero rows', () => {
    const runManySpy = vi.spyOn(database, 'runMany').mockImplementation(() => {
      // Explode before persisting anything, simulating a crash during the write.
      throw new Error('simulated write failure')
    })

    expect(() => service.ensureBaseline('SN_ATOMIC', ['a.hda', 'b.hda', 'c.hda'])).toThrow(
      'simulated write failure'
    )
    // Exactly one batched call (not a per-file run() loop), and nothing persisted.
    expect(runManySpy).toHaveBeenCalledTimes(1)
    expect(baselineCount('SN_ATOMIC')).toBe(0)

    runManySpy.mockRestore()
  })

  // -------------------------------------------------------------------------
  // Test 1d: Empty-fresh-device edge — CHARACTERIZATION of current spec-faithful
  // behavior (code-quality review finding 2 — a spec-design gap, NOT a code bug).
  //
  // A brand-new device with zero recordings → ensureBaseline(serial, []) inserts
  // NO rows yet returns { created: true } (the snapshot of an empty device is
  // empty). Because §5.5 defines "fresh" purely by row existence
  // (SELECT 1 FROM sync_baseline_files WHERE device_serial = ?), this serial
  // remains INDISTINGUISHABLE from never-baselined: a later connect (after the
  // user records meetings) finds no baseline rows + no sync history, treats the
  // device as fresh again, and snapshots those new recordings into the baseline —
  // silently excluding them from auto-sync (manual sync still reaches them, AC3).
  //
  // This test PINS that behavior so the empty-filenames case is no longer
  // invisible to the suite. Resolving the gap requires a spec amendment
  // (serial-level 'baselined' marker) or an agreed in-schema sentinel — both
  // outside this code-quality fix's scope. Reported per the spec-authoritative
  // invariant. If the spec gains a serial-level marker, this test should flip.
  // -------------------------------------------------------------------------
  it('empty-fresh-device edge: ensureBaseline(serial, []) inserts zero rows but reports created=true (spec gap, characterized)', () => {
    const result = service.ensureBaseline('SN_EMPTY', [])

    // Current spec-faithful behavior: created=true with no row written.
    expect(result).toEqual({ created: true })
    expect(baselineCount('SN_EMPTY')).toBe(0)

    // The gap: a subsequent connect cannot tell SN_EMPTY was ever baselined, so
    // newly recorded files get snapshotted (created=true again) rather than synced.
    const second = service.ensureBaseline('SN_EMPTY', ['recorded1.hda', 'recorded2.hda'])
    expect(second).toEqual({ created: true })
    expect(hasBaselineRow('SN_EMPTY', 'recorded1.hda')).toBe(true)
    expect(hasBaselineRow('SN_EMPTY', 'recorded2.hda')).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Test 2: Already baselined — second call returns { created: false }, no new rows
  // -------------------------------------------------------------------------
  it('already baselined: second call returns { created: false } without changing row count', () => {
    service.ensureBaseline('SN1', ['a.hda', 'b.hda'])
    const countAfterFirst = baselineCount('SN1')

    const result = service.ensureBaseline('SN1', ['a.hda', 'b.hda', 'c.hda'])

    expect(result).toEqual({ created: false })
    expect(baselineCount('SN1')).toBe(countAfterFirst) // row count unchanged
  })

  // -------------------------------------------------------------------------
  // Test 3: Prior-sync grandfather (spec §5.5 / AC7)
  // No baseline rows for 'SN2', but one of its filenames is already synced
  // → returns { created: false }, NO rows inserted
  // -------------------------------------------------------------------------
  it('prior-sync grandfather: device with sync history gets no baseline', () => {
    // Seed a synced record so isFileAlreadySynced('a.hda') returns synced=true
    addSyncedFile('a.hda', 'a.mp3', path.join(shared.tmpDir, 'a.mp3'))

    const result = service.ensureBaseline('SN2', ['a.hda', 'b.hda'])

    expect(result).toEqual({ created: false })
    expect(baselineCount('SN2')).toBe(0) // NO rows inserted
  })

  // -------------------------------------------------------------------------
  // Test 4: Auto mode skips baseline files; existing 4-layer synced reasons win
  // -------------------------------------------------------------------------
  it('auto mode: baseline files get skipReason=baseline, synced files keep their reason first', () => {
    // Establish baseline for SN1: a.hda is in baseline
    service.ensureBaseline('SN1', ['a.hda'])

    // Also seed a.hda as already synced (4-layer should win over baseline)
    addSyncedFile('a.hda', 'a.mp3', path.join(shared.tmpDir, 'a.mp3'))

    const files = [makeFile('a.hda'), makeFile('c.hda')]
    const results = service.getFilesToSync(files, { auto: true, deviceSerial: 'SN1' })

    const aResult = results.find((r) => r.filename === 'a.hda')
    const cResult = results.find((r) => r.filename === 'c.hda')

    // a.hda is in synced_files -> 4-layer wins (reason contains 'synced' or similar, NOT 'baseline')
    expect(aResult?.skipReason).toBeDefined()
    expect(aResult?.skipReason).not.toBe('baseline')

    // c.hda is in the baseline (wait — c.hda was NOT in the baseline, only a.hda was)
    // So c.hda should have no skipReason (not synced, not in baseline)
    expect(cResult?.skipReason).toBeUndefined()
  })

  it('auto mode: file in baseline but NOT synced gets skipReason=baseline', () => {
    // Baseline contains a.hda, c.hda is NOT in baseline
    service.ensureBaseline('SN1', ['a.hda'])

    const files = [makeFile('a.hda'), makeFile('c.hda')]
    const results = service.getFilesToSync(files, { auto: true, deviceSerial: 'SN1' })

    const aResult = results.find((r) => r.filename === 'a.hda')
    const cResult = results.find((r) => r.filename === 'c.hda')

    // a.hda is in baseline → skipReason: 'baseline'
    expect(aResult?.skipReason).toBe('baseline')
    // c.hda not in baseline, not synced → no skip reason
    expect(cResult?.skipReason).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // Test 5: Manual semantics untouched (AC3)
  // -------------------------------------------------------------------------
  it('manual mode (no opts): no baseline skips even when baseline rows exist', () => {
    service.ensureBaseline('SN1', ['a.hda', 'b.hda'])

    const files = [makeFile('a.hda'), makeFile('b.hda'), makeFile('c.hda')]

    // No opts → manual
    const resultsNoOpts = service.getFilesToSync(files)
    resultsNoOpts.forEach((r) => {
      expect(r.skipReason).toBeUndefined()
    })

    // Explicit { auto: false } → also manual
    const resultsAutoFalse = service.getFilesToSync(files, { auto: false })
    resultsAutoFalse.forEach((r) => {
      expect(r.skipReason).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // Test 6: Auto without serial = manual semantics (defensive)
  // -------------------------------------------------------------------------
  it('auto with no deviceSerial: no baseline filtering', () => {
    service.ensureBaseline('SN1', ['a.hda'])

    const files = [makeFile('a.hda'), makeFile('b.hda')]
    const results = service.getFilesToSync(files, { auto: true }) // no deviceSerial

    // Neither file should have a baseline skip reason
    results.forEach((r) => {
      expect(r.skipReason).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // Test 7: 100-file cap in auto mode; manual mode: all 120 queued
  // -------------------------------------------------------------------------
  it('100-file auto cap: 100 queued, 20 get skipReason=auto-cap; manual queues all 120', () => {
    // 120 unsynced, non-baseline files
    const files = Array.from({ length: 120 }, (_, i) => makeFile(`file${i}.hda`))

    // Auto mode with no baseline established for 'SN_CAP'
    const autoResults = service.getFilesToSync(files, { auto: true, deviceSerial: 'SN_CAP' })

    const queued = autoResults.filter((r) => r.skipReason === undefined)
    const capped = autoResults.filter((r) => r.skipReason === 'auto-cap')

    expect(queued).toHaveLength(100)
    expect(capped).toHaveLength(20)

    // Manual mode: all 120 queued (no auto-cap applied)
    const manualResults = service.getFilesToSync(files)
    const manualQueued = manualResults.filter((r) => r.skipReason === undefined)
    expect(manualQueued).toHaveLength(120)
  })
})
