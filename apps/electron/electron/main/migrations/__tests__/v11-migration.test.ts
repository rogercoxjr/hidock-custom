
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { migrateToV11Impl } from '../../ipc/migration-handlers'
import BetterSqlite3 from 'better-sqlite3'

// Mock Electron
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: vi.fn()
}))

let dbInstance: any = null

vi.mock('../../services/database', () => ({
  getDatabase: () => dbInstance,
  runInTransaction: (fn: any) => fn(),
  saveDatabase: vi.fn()
}))

describe('V11 Migration', () => {
  beforeEach(() => {
    dbInstance = new BetterSqlite3(':memory:')

    dbInstance.exec(`
      CREATE TABLE recordings (
        id TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        date_recorded TEXT NOT NULL,
        meeting_id TEXT,
        status TEXT
      );
      CREATE TABLE transcripts (
        id TEXT PRIMARY KEY,
        recording_id TEXT NOT NULL,
        full_text TEXT,
        summary TEXT,
        action_items TEXT
      );
      CREATE TABLE meetings (id TEXT PRIMARY KEY, subject TEXT);
      CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
    `)

    dbInstance.exec(`
      INSERT INTO recordings (id, filename, date_recorded, status) VALUES
        ('rec-1', 'test.wav', '2025-01-01T10:00:00Z', 'transcribed');
      INSERT INTO transcripts (id, recording_id, full_text, summary, action_items) VALUES
        ('trans-1', 'rec-1', 'Hello world', 'A summary', '["Action 1"]');
    `)
  })

  afterEach(() => {
    if (dbInstance) dbInstance.close()
    vi.clearAllMocks()
  })

  it('should migrate recordings to knowledge captures', async () => {
    const result = await migrateToV11Impl()
    expect(result.success).toBe(true)
    expect(result.capturesCreated).toBe(1)

    const capture = dbInstance.prepare("SELECT * FROM knowledge_captures").get() as Record<string, unknown> | undefined
    expect(capture).toBeDefined()
    expect(capture!.title).toBe('Recording: test.wav')
  })
})
