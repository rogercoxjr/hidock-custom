import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('database boot (better-sqlite3)', () => {
  let dir: string
  beforeEach(() => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-db-'))
    process.env.HIDOCK_DATA_ROOT = dir
  })
  afterEach(async () => {
    const { closeDatabase } = await import('../database')
    try { closeDatabase() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
    delete process.env.HIDOCK_DATA_ROOT
  })

  it('boots a fresh DB to schema version 33', async () => {
    const { initializeFileStorage } = await import('../file-storage')
    const db = await import('../database')
    await initializeFileStorage()
    await db.initializeDatabase()
    const row = db.queryOne<{ version: number }>(
      'SELECT version FROM schema_version ORDER BY version DESC LIMIT 1'
    )
    expect(row?.version).toBe(33)
  })

  it('queryAll / run round-trip with spread params', async () => {
    const { initializeFileStorage } = await import('../file-storage')
    const db = await import('../database')
    await initializeFileStorage()
    await db.initializeDatabase()
    db.run("INSERT INTO projects (id, name, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)", ['p1', 'Proj'])
    const rows = db.queryAll<{ id: string; name: string }>('SELECT id, name FROM projects WHERE id = ?', ['p1'])
    expect(rows).toEqual([{ id: 'p1', name: 'Proj' }])
  })

  it('runInTransaction rolls back on throw', async () => {
    const { initializeFileStorage } = await import('../file-storage')
    const db = await import('../database')
    await initializeFileStorage()
    await db.initializeDatabase()
    expect(() => db.runInTransaction(() => {
      db.runNoSave("INSERT INTO projects (id, name, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)", ['p2', 'X'])
      throw new Error('boom')
    })).toThrow('boom')
    expect(db.queryOne('SELECT id FROM projects WHERE id = ?', ['p2'])).toBeUndefined()
  })

  it('re-boot on an existing file is idempotent (stays at 33)', async () => {
    const { initializeFileStorage } = await import('../file-storage')
    const db = await import('../database')
    await initializeFileStorage()
    await db.initializeDatabase()
    db.closeDatabase()
    vi.resetModules()
    const db2 = await import('../database')
    await db2.initializeDatabase()
    const row = db2.queryOne<{ version: number }>('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
    expect(row?.version).toBe(33)
  })
})
