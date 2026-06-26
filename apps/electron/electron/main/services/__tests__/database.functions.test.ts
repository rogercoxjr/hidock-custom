import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('database function conversions (better-sqlite3)', () => {
  let dir: string

  beforeEach(() => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-db-fn-'))
    process.env.HIDOCK_DATA_ROOT = dir
  })

  afterEach(async () => {
    const { closeDatabase } = await import('../database')
    try { closeDatabase() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
    delete process.env.HIDOCK_DATA_ROOT
  })

  it('selectMeetingForRecordingByUser links a recording to a meeting', async () => {
    const { initializeFileStorage } = await import('../file-storage')
    const db = await import('../database')
    await initializeFileStorage()
    await db.initializeDatabase()

    // Insert a meeting (NOT NULL: id, subject, start_time, end_time)
    db.run(
      `INSERT INTO meetings (id, subject, start_time, end_time) VALUES (?, ?, ?, ?)`,
      ['m1', 'Test Meeting', '2026-01-01T10:00:00', '2026-01-01T11:00:00']
    )

    // Insert a recording (NOT NULL: id, filename, date_recorded)
    db.run(
      `INSERT INTO recordings (id, filename, date_recorded) VALUES (?, ?, ?)`,
      ['r1', 'test.wav', '2026-01-01T10:00:00']
    )

    // Should not throw
    expect(() =>
      db.selectMeetingForRecordingByUser('r1', 'm1')
    ).not.toThrow()

    // recording should now be linked to the meeting
    const row = db.queryOne<{ meeting_id: string; correlation_method: string }>(
      `SELECT meeting_id, correlation_method FROM recordings WHERE id = ?`,
      ['r1']
    )
    expect(row?.meeting_id).toBe('m1')
    expect(row?.correlation_method).toBe('user_override')
  })

  it('selectMeetingForRecordingByUser with meetingId=null marks recording as standalone', async () => {
    const { initializeFileStorage } = await import('../file-storage')
    const db = await import('../database')
    await initializeFileStorage()
    await db.initializeDatabase()

    // Insert a recording pre-linked to a meeting
    db.run(
      `INSERT INTO meetings (id, subject, start_time, end_time) VALUES (?, ?, ?, ?)`,
      ['m2', 'Another Meeting', '2026-01-02T10:00:00', '2026-01-02T11:00:00']
    )
    db.run(
      `INSERT INTO recordings (id, filename, date_recorded, meeting_id) VALUES (?, ?, ?, ?)`,
      ['r2', 'test2.wav', '2026-01-02T10:00:00', 'm2']
    )

    // Deselect meeting (pass null)
    expect(() =>
      db.selectMeetingForRecordingByUser('r2', null)
    ).not.toThrow()

    const row = db.queryOne<{ meeting_id: string | null; correlation_method: string }>(
      `SELECT meeting_id, correlation_method FROM recordings WHERE id = ?`,
      ['r2']
    )
    expect(row?.meeting_id).toBeNull()
    expect(row?.correlation_method).toBe('user_standalone')
  })

  it('resetStuckTranscriptions resets processing/pending recordings and processing queue items', async () => {
    const { initializeFileStorage } = await import('../file-storage')
    const db = await import('../database')
    await initializeFileStorage()
    await db.initializeDatabase()

    // Insert two recordings in stuck states
    db.run(
      `INSERT INTO recordings (id, filename, date_recorded, transcription_status) VALUES (?, ?, ?, ?)`,
      ['r10', 'stuck1.wav', '2026-01-10T10:00:00', 'processing']
    )
    db.run(
      `INSERT INTO recordings (id, filename, date_recorded, transcription_status) VALUES (?, ?, ?, ?)`,
      ['r11', 'stuck2.wav', '2026-01-10T11:00:00', 'pending']
    )
    // One recording that should NOT be reset
    db.run(
      `INSERT INTO recordings (id, filename, date_recorded, transcription_status) VALUES (?, ?, ?, ?)`,
      ['r12', 'done.wav', '2026-01-10T12:00:00', 'complete']
    )

    // Insert a queue item in stuck 'processing' state
    db.run(
      `INSERT INTO transcription_queue (id, recording_id, status) VALUES (?, ?, ?)`,
      ['q1', 'r10', 'processing']
    )
    // Insert a queue item already 'pending' — should not change count (it's already pending, but
    // the UPDATE targets only 'processing' rows, so changes = 0 for this one)
    db.run(
      `INSERT INTO transcription_queue (id, recording_id, status) VALUES (?, ?, ?)`,
      ['q2', 'r11', 'pending']
    )

    const result = db.resetStuckTranscriptions()

    // 2 recordings reset (processing + pending → none)
    expect(result.recordingsReset).toBe(2)
    // 1 queue item reset (processing → pending)
    expect(result.queueItemsReset).toBe(1)

    // Verify actual DB state
    const rec10 = db.queryOne<{ transcription_status: string }>(
      `SELECT transcription_status FROM recordings WHERE id = ?`, ['r10']
    )
    expect(rec10?.transcription_status).toBe('none')

    const rec12 = db.queryOne<{ transcription_status: string }>(
      `SELECT transcription_status FROM recordings WHERE id = ?`, ['r12']
    )
    expect(rec12?.transcription_status).toBe('complete')

    const q1row = db.queryOne<{ status: string }>(
      `SELECT status FROM transcription_queue WHERE id = ?`, ['q1']
    )
    expect(q1row?.status).toBe('pending')
  })
})
