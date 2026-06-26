/**
 * First-sync baseline tests — auto-pipeline P5 (spec 2026-06-11 §5.5, AC2, AC3).
 *
 * Backed by the REAL better-sqlite3 database (canonical harness — see
 * database.boot.test.ts): each test gets a fresh HIDOCK_DATA_ROOT temp dir +
 * vi.resetModules(), then initializeFileStorage() + initializeDatabase() build
 * the real schema on disk (including sync_baseline_files). ensureBaseline and the
 * baseline-aware getFilesToSync therefore run against the real schema and real
 * query helpers. The ONLY mock is `electron` — a genuine external boundary that
 * download-service imports at module load and that cannot resolve in the node
 * test environment. (A fresh per-test data root also means the on-disk
 * isFileAlreadySynced checks naturally miss, so no fs.existsSync mock is needed.)
 */
// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ---------------------------------------------------------------------------
// External-boundary mock: download-service imports `electron` at module top.
// ---------------------------------------------------------------------------
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => tmpdir()),
    getName: vi.fn(() => 'test')
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() },
  Notification: { isSupported: vi.fn(() => false) }
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a device file descriptor */
function makeFile(filename: string) {
  return { filename, size: 1024, duration: 60, dateCreated: new Date('2024-01-01') }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ensureBaseline + baseline-aware getFilesToSync (auto-pipeline P5)', () => {
  let dir: string

  beforeEach(() => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-baseline-'))
    process.env.HIDOCK_DATA_ROOT = dir
  })

  afterEach(async () => {
    const { closeDatabase } = await import('../database')
    try {
      closeDatabase()
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true })
    delete process.env.HIDOCK_DATA_ROOT
  })

  /**
   * Boot the real file storage + database for the current temp root, then return
   * the freshly-reset database namespace and a download service backed by it.
   * Both modules come from the SAME post-resetModules graph so vi.spyOn on the
   * database namespace is observed by download-service's named imports.
   */
  async function setup() {
    const { initializeFileStorage } = await import('../file-storage')
    const database = await import('../database')
    const { getDownloadService } = await import('../download-service')
    await initializeFileStorage()
    await database.initializeDatabase()
    const service = getDownloadService()
    return { database, service }
  }

  /** Count baseline rows for a serial */
  function baselineCount(database: typeof import('../database'), serial: string): number {
    return (
      database.queryOne<{ n: number }>(
        'SELECT COUNT(*) AS n FROM sync_baseline_files WHERE device_serial = ?',
        [serial]
      )?.n ?? 0
    )
  }

  /** Check whether a specific baseline row exists */
  function hasBaselineRow(
    database: typeof import('../database'),
    serial: string,
    filename: string
  ): boolean {
    return !!database.queryOne(
      'SELECT 1 FROM sync_baseline_files WHERE device_serial = ? AND filename = ?',
      [serial, filename]
    )
  }

  // -------------------------------------------------------------------------
  // Test 1: Fresh device — no baseline rows, no prior sync history
  // -------------------------------------------------------------------------
  it('fresh device: ensureBaseline inserts rows and returns { created: true }', async () => {
    const { database, service } = await setup()
    const result = service.ensureBaseline('SN1', ['a.hda', 'b.hda'])

    expect(result).toEqual({ created: true })
    expect(baselineCount(database, 'SN1')).toBe(2)
    expect(hasBaselineRow(database, 'SN1', 'a.hda')).toBe(true)
    expect(hasBaselineRow(database, 'SN1', 'b.hda')).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Test 1b: Bulk insert is ONE batched write, not a per-file run() loop
  // (code-quality review finding 1). A ~1400-file fresh-device backlog through
  // the old per-row run() would do a full db.export() + writeFileSync per file
  // (N serializations). runMany binds every row to one prepared statement and
  // serializes exactly once — so the batched path is taken and run() is not.
  // -------------------------------------------------------------------------
  it('fresh device: bulk insert uses one runMany call, not a per-file run() loop', async () => {
    const { database, service } = await setup()
    const runManySpy = vi.spyOn(database, 'runMany')
    const runSpy = vi.spyOn(database, 'run')
    const filenames = Array.from({ length: 50 }, (_, i) => `f${i}.hda`)

    const result = service.ensureBaseline('SN_BULK', filenames)

    expect(result).toEqual({ created: true })
    expect(baselineCount(database, 'SN_BULK')).toBe(50)
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
  it('fresh device: the insert is one batched call and a failure persists zero rows', async () => {
    const { database, service } = await setup()
    const runManySpy = vi.spyOn(database, 'runMany').mockImplementation(() => {
      // Explode before persisting anything, simulating a crash during the write.
      throw new Error('simulated write failure')
    })

    expect(() => service.ensureBaseline('SN_ATOMIC', ['a.hda', 'b.hda', 'c.hda'])).toThrow(
      'simulated write failure'
    )
    // Exactly one batched call (not a per-file run() loop), and nothing persisted.
    expect(runManySpy).toHaveBeenCalledTimes(1)
    expect(baselineCount(database, 'SN_ATOMIC')).toBe(0)

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
  it('empty-fresh-device edge: ensureBaseline(serial, []) inserts zero rows but reports created=true (spec gap, characterized)', async () => {
    const { database, service } = await setup()
    const result = service.ensureBaseline('SN_EMPTY', [])

    // Current spec-faithful behavior: created=true with no row written.
    expect(result).toEqual({ created: true })
    expect(baselineCount(database, 'SN_EMPTY')).toBe(0)

    // The gap: a subsequent connect cannot tell SN_EMPTY was ever baselined, so
    // newly recorded files get snapshotted (created=true again) rather than synced.
    const second = service.ensureBaseline('SN_EMPTY', ['recorded1.hda', 'recorded2.hda'])
    expect(second).toEqual({ created: true })
    expect(hasBaselineRow(database, 'SN_EMPTY', 'recorded1.hda')).toBe(true)
    expect(hasBaselineRow(database, 'SN_EMPTY', 'recorded2.hda')).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Test 2: Already baselined — second call returns { created: false }, no new rows
  // -------------------------------------------------------------------------
  it('already baselined: second call returns { created: false } without changing row count', async () => {
    const { database, service } = await setup()
    service.ensureBaseline('SN1', ['a.hda', 'b.hda'])
    const countAfterFirst = baselineCount(database, 'SN1')

    const result = service.ensureBaseline('SN1', ['a.hda', 'b.hda', 'c.hda'])

    expect(result).toEqual({ created: false })
    expect(baselineCount(database, 'SN1')).toBe(countAfterFirst) // row count unchanged
  })

  // -------------------------------------------------------------------------
  // Test 3: Prior-sync grandfather (spec §5.5 / AC7)
  // No baseline rows for 'SN2', but one of its filenames is already synced
  // → returns { created: false }, NO rows inserted
  // -------------------------------------------------------------------------
  it('prior-sync grandfather: device with sync history gets no baseline', async () => {
    const { database, service } = await setup()
    // Seed a synced record so isFileAlreadySynced('a.hda') returns synced=true
    database.addSyncedFile('a.hda', 'a.mp3', join(dir, 'a.mp3'))

    const result = service.ensureBaseline('SN2', ['a.hda', 'b.hda'])

    expect(result).toEqual({ created: false })
    expect(baselineCount(database, 'SN2')).toBe(0) // NO rows inserted
  })

  // -------------------------------------------------------------------------
  // Test 4: Auto mode skips baseline files; existing 4-layer synced reasons win
  // -------------------------------------------------------------------------
  it('auto mode: baseline files get skipReason=baseline, synced files keep their reason first', async () => {
    const { database, service } = await setup()
    // Establish baseline for SN1: a.hda is in baseline
    service.ensureBaseline('SN1', ['a.hda'])

    // Also seed a.hda as already synced (4-layer should win over baseline)
    database.addSyncedFile('a.hda', 'a.mp3', join(dir, 'a.mp3'))

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

  it('auto mode: file in baseline but NOT synced gets skipReason=baseline', async () => {
    const { service } = await setup()
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
  it('manual mode (no opts): no baseline skips even when baseline rows exist', async () => {
    const { service } = await setup()
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
  it('auto with no deviceSerial: no baseline filtering', async () => {
    const { service } = await setup()
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
  it('100-file auto cap: 100 queued, 20 get skipReason=auto-cap; manual queues all 120', async () => {
    const { service } = await setup()
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
