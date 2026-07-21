import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Regression: People page showed 0 interactions for everyone except the self
 * contact. Root cause — getContacts reported `interactionCount = contacts.meeting_count`,
 * a scalar bumped ONLY by calendar/meeting ingestion, never by assigning a person
 * as a speaker in a recording. A contact assigned to recordings (recording_speakers)
 * or present as a meeting attendee (meeting_contacts) must report a live-derived count.
 */
describe('getContacts interaction count (live-derived)', () => {
  let dir: string

  beforeEach(() => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-db-ic-'))
    process.env.HIDOCK_DATA_ROOT = dir
  })

  afterEach(async () => {
    const { closeDatabase } = await import('../database')
    try { closeDatabase() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
    delete process.env.HIDOCK_DATA_ROOT
  })

  it('counts speaker-assignment recordings and meeting attendance as interactions', async () => {
    const { initializeFileStorage } = await import('../file-storage')
    const db = await import('../database')
    await initializeFileStorage()
    await db.initializeDatabase()

    const now = '2026-01-01T10:00:00'

    // A manually-added contact — meeting_count stays 0 (the old field).
    db.run(
      `INSERT INTO contacts (id, name, first_seen_at, last_seen_at, meeting_count) VALUES (?, ?, ?, ?, 0)`,
      ['alice', 'Alice', now, now]
    )

    // Two recordings, Alice assigned as a speaker in both (recording_speakers).
    db.run(`INSERT INTO recordings (id, filename, date_recorded) VALUES ('r1', 'a.wav', ?)`, [now])
    db.run(`INSERT INTO recordings (id, filename, date_recorded) VALUES ('r2', 'b.wav', ?)`, [now])
    db.run(
      `INSERT INTO recording_speakers (recording_id, file_label, contact_id, source, created_at) VALUES ('r1','A','alice','user',?)`,
      [now]
    )
    db.run(
      `INSERT INTO recording_speakers (recording_id, file_label, contact_id, source, created_at) VALUES ('r2','B','alice','user',?)`,
      [now]
    )

    // One meeting Alice attends (meeting_contacts).
    db.run(
      `INSERT INTO meetings (id, subject, start_time, end_time) VALUES ('m1','Sync', ?, ?)`,
      [now, now]
    )
    db.run(`INSERT INTO meeting_contacts (meeting_id, contact_id, role) VALUES ('m1','alice','attendee')`)

    const { contacts } = db.getContacts()
    const alice = contacts.find((c) => c.id === 'alice')!
    expect(alice).toBeTruthy()

    // 2 distinct recordings + 1 meeting = 3 interactions. (Pre-fix: meeting_count = 0.)
    expect((alice as unknown as { interaction_count: number }).interaction_count).toBe(3)
  })

  it('does not double-count multiple speaker labels within the same recording', async () => {
    const { initializeFileStorage } = await import('../file-storage')
    const db = await import('../database')
    await initializeFileStorage()
    await db.initializeDatabase()

    const now = '2026-01-02T10:00:00'
    db.run(
      `INSERT INTO contacts (id, name, first_seen_at, last_seen_at, meeting_count) VALUES (?, ?, ?, ?, 0)`,
      ['bob', 'Bob', now, now]
    )
    db.run(`INSERT INTO recordings (id, filename, date_recorded) VALUES ('r3', 'c.wav', ?)`, [now])
    // Same recording, two labels both resolved to Bob → still ONE interaction.
    db.run(
      `INSERT INTO recording_speakers (recording_id, file_label, contact_id, source, created_at) VALUES ('r3','A','bob','user',?)`,
      [now]
    )
    db.run(
      `INSERT INTO recording_speakers (recording_id, file_label, contact_id, source, created_at) VALUES ('r3','B','bob','user',?)`,
      [now]
    )

    const { contacts } = db.getContacts()
    const bob = contacts.find((c) => c.id === 'bob')!
    expect((bob as unknown as { interaction_count: number }).interaction_count).toBe(1)
  })
})
