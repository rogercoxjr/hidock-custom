import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('allowed_users', () => {
  let dir: string
  beforeEach(async () => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-au-'))
    process.env.HIDOCK_DATA_ROOT = dir
    const { initializeFileStorage } = await import('../file-storage')
    const { initializeDatabase } = await import('../database')
    await initializeFileStorage()
    await initializeDatabase()
  })
  afterEach(async () => {
    const { closeDatabase } = await import('../database')
    try { closeDatabase() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
    delete process.env.HIDOCK_DATA_ROOT
  })

  it('boots to schema version 34', async () => {
    const { queryOne } = await import('../database')
    expect(queryOne<{ version: number }>('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')?.version).toBe(34)
  })

  it('ensureBootstrapAdmin inserts an admin once and is idempotent', async () => {
    const db = await import('../database')
    db.ensureBootstrapAdmin('boss@x.com')
    db.ensureBootstrapAdmin('boss@x.com')
    expect(db.getAllowedUser('boss@x.com')).toMatchObject({ email: 'boss@x.com', role: 'admin', status: 'active' })
    expect(db.listAllowedUsers()).toHaveLength(1)
    expect(db.countActiveAdmins()).toBe(1)
  })

  it('upsert + status + lookup round-trip', async () => {
    const db = await import('../database')
    db.upsertAllowedUser({ email: 'm@x.com', invitedBy: 'boss@x.com' })
    expect(db.getAllowedUser('m@x.com')).toMatchObject({ role: 'member', status: 'active', invited_by: 'boss@x.com' })
    db.setAllowedUserStatus('m@x.com', 'revoked')
    expect(db.getAllowedUser('m@x.com')?.status).toBe('revoked')
  })

  it('countActiveAdmins ignores members and revoked admins', async () => {
    const db = await import('../database')
    db.ensureBootstrapAdmin('a1@x.com')
    db.upsertAllowedUser({ email: 'a2@x.com', role: 'admin' })
    db.upsertAllowedUser({ email: 'm@x.com', role: 'member' })
    expect(db.countActiveAdmins()).toBe(2)
    db.setAllowedUserStatus('a2@x.com', 'revoked')
    expect(db.countActiveAdmins()).toBe(1)
  })
})
