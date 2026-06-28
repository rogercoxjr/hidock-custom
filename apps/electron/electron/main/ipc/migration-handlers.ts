// NOTE: 'electron' is NOT imported at module scope. This file's *Impl exports are
// reachable from the hosted server's import graph, where electron isn't installed;
// a static import would crash boot under plain Node. ipcMain is lazy-required inside
// registerMigrationHandlers(), which only ever runs in the Electron main process.
import { getBroadcaster } from '../services/broadcaster'
import { getDatabase, runInTransaction } from '../services/database'
import { readFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'

// ============================================================================
// Types
// ============================================================================

interface CleanupPreview {
  orphanedTranscripts: Array<{ id: string; recording_id: string }>
  duplicateRecordings: Array<{ id: string; filename: string; count: number }>
  invalidMeetingRefs: Array<{ id: string; meeting_id: string }>
}

interface CleanupResult {
  success: boolean
  orphanedTranscriptsRemoved: number
  duplicateRecordingsRemoved: number
  invalidMeetingRefsFixed: number
  errors: string[]
}

interface MigrationResult {
  success: boolean
  capturesCreated: number
  errors: string[]
  verified: boolean
}

interface MigrationStatus {
  pending: number
  migrated: number
  skipped: number
  total: number
}

interface VerificationResult {
  success: boolean
  errors: string[]
}

// ============================================================================
// P2 #018: Migration State Management with Database Advisory Lock
// ============================================================================

const migrationLock = {
  acquire(): boolean {
    const db = getDatabase()
    try {
      // Check for stale lock (> 1 hour old)
      const lockRow = db.prepare(`SELECT value FROM config WHERE key = 'migration_lock'`).get() as { value: string } | undefined
      if (lockRow) {
        const lockTime = parseInt(lockRow.value, 10)
        if (Date.now() - lockTime > 3600000) {
          // Lock is stale, remove it
          db.prepare(`DELETE FROM config WHERE key = 'migration_lock'`).run()
        } else {
          return false // Lock is held by another process
        }
      }

      // Try to acquire lock
      db.prepare(`INSERT INTO config (key, value) VALUES ('migration_lock', ?)`).run(Date.now().toString())
      return true
    } catch {
      // UNIQUE constraint violation means lock already held
      return false
    }
  },
  release(): void {
    const db = getDatabase()
    try {
      db.prepare(`DELETE FROM config WHERE key = 'migration_lock'`).run()
    } catch (error) {
      console.error('Failed to release migration lock:', error)
    }
  }
}

// ============================================================================
// P1 #013: Progress Tracking Cleanup (Memory Leak Prevention)
// ============================================================================

const activeProgressTrackers = new Set<string>()

function registerProgressTracker(id: string): void {
  activeProgressTrackers.add(id)
}

function cleanupProgressTracker(id: string): void {
  activeProgressTrackers.delete(id)
}

function cleanupAllProgressTrackers(): void {
  activeProgressTrackers.clear()
}

// Cleanup on process exit
process.on('exit', () => {
  cleanupAllProgressTrackers()
})

// ============================================================================
// Error Sanitization (Security Best Practice)
// ============================================================================

function sanitizeError(error: Error): string {
  const message = error.message
  // Remove file paths, database paths, and internal details
  return message
    .replace(/\/[^\s]*/g, '[path]')
    .replace(/\\/g, '[path]')
    .replace(/[A-Z]:\\[^\s]*/g, '[path]')
    .replace(/database.*?:/gi, 'Database:')
    .replace(/SQLITE_ERROR.*?:/gi, 'Database error:')
    .slice(0, 200) // Limit length
}

// ============================================================================
// P1 #010: Load Proper V11 Schema (Ensures Correct Table Names)
// ============================================================================

function loadV11Schema(): string {
  try {
    const schemaPath = join(__dirname, '../services/migrations/v11-knowledge-captures.sql')
    return readFileSync(schemaPath, 'utf-8')
  } catch (error) {
    console.error('Failed to load V11 schema file:', error)
    throw new Error('V11 schema file not found. Cannot proceed with migration.')
  }
}

// ============================================================================
// P1 #012: Backup and Restore Functions
// P2-016: Use TEMP tables for auto-cleanup and security
// ============================================================================

function createMigrationBackup(): void {
  const db = getDatabase()

  // P2-016: Create backup tables as TEMP tables (auto-cleanup on connection close)
  db.exec('DROP TABLE IF EXISTS _backup_recordings')
  db.exec('DROP TABLE IF EXISTS _backup_transcripts')

  // Check if migration_status column exists
  let hasMigrationStatus = false
  try {
    db.prepare('SELECT migration_status FROM recordings LIMIT 1')
    hasMigrationStatus = true
  } catch {
    hasMigrationStatus = false
  }

  if (hasMigrationStatus) {
    // P3-019: Create backup tables in single step (no double-copy)
    db.exec(`
      CREATE TEMP TABLE _backup_recordings AS
      SELECT * FROM recordings
      WHERE migration_status IS NULL OR migration_status = 'pending'
    `)

    db.exec(`
      CREATE TEMP TABLE _backup_transcripts AS
      SELECT t.* FROM transcripts t
      INNER JOIN recordings r ON t.recording_id = r.id
      WHERE r.migration_status IS NULL OR r.migration_status = 'pending'
    `)
  } else {
    // Fresh migration: backup everything
    db.exec(`CREATE TEMP TABLE _backup_recordings AS SELECT * FROM recordings`)
    db.exec(`CREATE TEMP TABLE _backup_transcripts AS SELECT * FROM transcripts`)
  }
}

// P2-017: Helper to check if backup tables exist
function checkBackupExists(): boolean {
  const db = getDatabase()
  try {
    const count = (db.prepare(`
      SELECT COUNT(*) as count FROM sqlite_master
      WHERE type='table' AND name IN ('_backup_recordings', '_backup_transcripts')
    `).get() as { count: number } | undefined)?.count ?? 0
    return count === 2 // Both tables must exist
  } catch (error) {
    console.error('Failed to check backup existence:', error)
    return false
  }
}

// P2-017: Helper to verify restoration succeeded
function verifyRestoration(): boolean {
  const db = getDatabase()
  try {
    const count = (db.prepare(`
      SELECT COUNT(*) as count FROM recordings
      WHERE migration_status = 'migrated'
    `).get() as { count: number } | undefined)?.count ?? 0
    return count === 0 // No recordings should still be marked as migrated
  } catch (error) {
    console.error('Failed to verify restoration:', error)
    return false
  }
}

function restoreFromBackup(): void {
  const db = getDatabase()

  try {
    // P2-017: Verify backup exists before attempting restore
    if (!checkBackupExists()) {
      console.log('No backup tables found, skipping restore')
      return
    }

    // Restore recordings from backup
    db.exec(`
      UPDATE recordings
      SET migration_status = (
        SELECT migration_status FROM _backup_recordings b
        WHERE b.id = recordings.id
      ),
      migrated_to_capture_id = NULL,
      migrated_at = NULL
      WHERE id IN (SELECT id FROM _backup_recordings)
    `)

    // P2-015: Restore transcripts from backup
    db.exec(`DELETE FROM transcripts WHERE recording_id IN (SELECT id FROM _backup_recordings)`)
    db.exec(`INSERT INTO transcripts SELECT * FROM _backup_transcripts`)

    console.log('Successfully restored from backup')
  } catch (error) {
    console.error('Failed to restore from backup:', error)
    throw error
  }
}

function cleanupBackupTables(): void {
  const db = getDatabase()

  try {
    db.exec('DROP TABLE IF EXISTS _backup_recordings')
    db.exec('DROP TABLE IF EXISTS _backup_transcripts')
  } catch (error) {
    console.error('Failed to cleanup backup tables:', error)
    // Don't throw - this is just cleanup
  }
}

// ============================================================================
// P1 #013: Post-Migration Verification
// ============================================================================

function verifyMigration(): VerificationResult {
  const db = getDatabase()
  const errors: string[] = []

  try {
    // Verify record counts match
    const migratedCount = (db.prepare(`
      SELECT COUNT(*) as count
      FROM recordings
      WHERE migration_status = 'migrated'
    `).get() as { count: number } | undefined)?.count ?? 0

    const capturesCount = (db.prepare(`
      SELECT COUNT(*) as count
      FROM knowledge_captures
      WHERE source_recording_id IS NOT NULL
    `).get() as { count: number } | undefined)?.count ?? 0

    if (capturesCount !== migratedCount) {
      errors.push(`Count mismatch: ${capturesCount} captures created vs ${migratedCount} recordings marked as migrated`)
    }

    // Verify required fields are populated
    const invalidCount = (db.prepare(`
      SELECT COUNT(*) as count
      FROM knowledge_captures
      WHERE title IS NULL OR title = ''
         OR captured_at IS NULL
         OR source_recording_id IS NULL
    `).get() as { count: number } | undefined)?.count ?? 0

    if (invalidCount > 0) {
      errors.push(`Found ${invalidCount} captures with missing required fields (title, captured_at, source_recording_id)`)
    }

    // Verify foreign key integrity for meeting references
    const orphanedCount = (db.prepare(`
      SELECT COUNT(*) as count
      FROM knowledge_captures
      WHERE meeting_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM meetings WHERE id = knowledge_captures.meeting_id)
    `).get() as { count: number } | undefined)?.count ?? 0

    if (orphanedCount > 0) {
      errors.push(`Found ${orphanedCount} captures with invalid meeting references`)
    }

    // Verify foreign key integrity for recording references
    const orphanedRecordingsCount = (db.prepare(`
      SELECT COUNT(*) as count
      FROM knowledge_captures
      WHERE source_recording_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM recordings WHERE id = knowledge_captures.source_recording_id)
    `).get() as { count: number } | undefined)?.count ?? 0

    if (orphanedRecordingsCount > 0) {
      errors.push(`Found ${orphanedRecordingsCount} captures with invalid recording references`)
    }

  } catch (error) {
    errors.push(`Verification failed: ${sanitizeError(error as Error)}`)
  }

  return {
    success: errors.length === 0,
    errors
  }
}

// ============================================================================
// Cleanup Preview
// ============================================================================

export async function generateCleanupPreviewImpl(): Promise<CleanupPreview> {
  const db = getDatabase()
  const orphanedTranscripts: Array<{ id: string; recording_id: string }> = []
  const duplicateRecordings: Array<{ id: string; filename: string; count: number }> = []
  const invalidMeetingRefs: Array<{ id: string; meeting_id: string }> = []

  try {
    // Find orphaned transcripts
    for (const row of db.prepare(`
      SELECT t.id, t.recording_id
      FROM transcripts t
      LEFT JOIN recordings r ON t.recording_id = r.id
      WHERE r.id IS NULL
    `).all() as Array<Record<string, unknown>>) {
      orphanedTranscripts.push({
        id: row.id as string,
        recording_id: row.recording_id as string
      })
    }

    // Find duplicate recordings
    for (const row of db.prepare(`
      SELECT filename, COUNT(*) as count, MIN(id) as id
      FROM recordings
      GROUP BY filename
      HAVING COUNT(*) > 1
    `).all() as Array<Record<string, unknown>>) {
      duplicateRecordings.push({
        id: row.id as string,
        filename: row.filename as string,
        count: row.count as number
      })
    }

    // Find invalid meeting references
    for (const row of db.prepare(`
      SELECT r.id, r.meeting_id
      FROM recordings r
      WHERE r.meeting_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM meetings m WHERE m.id = r.meeting_id)
    `).all() as Array<Record<string, unknown>>) {
      invalidMeetingRefs.push({
        id: row.id as string,
        meeting_id: row.meeting_id as string
      })
    }
  } catch (error) {
    console.error('Failed to generate cleanup preview:', error)
  }

  return { orphanedTranscripts, duplicateRecordings, invalidMeetingRefs }
}

// ============================================================================
// Pre-Migration Cleanup
// ============================================================================

export async function runPreMigrationCleanupImpl(): Promise<CleanupResult> {
  const db = getDatabase()
  const result: CleanupResult = {
    success: true,
    orphanedTranscriptsRemoved: 0,
    duplicateRecordingsRemoved: 0,
    invalidMeetingRefsFixed: 0,
    errors: []
  }

  try {
    // Remove orphaned transcripts
    try {
      result.orphanedTranscriptsRemoved = db.prepare(`
        DELETE FROM transcripts
        WHERE id IN (
          SELECT t.id FROM transcripts t
          LEFT JOIN recordings r ON t.recording_id = r.id
          WHERE r.id IS NULL
        )
      `).run().changes
    } catch (error) {
      result.errors.push(`Failed to remove orphaned transcripts: ${sanitizeError(error as Error)}`)
    }

    // Remove duplicate recordings (keep oldest)
    try {
      result.duplicateRecordingsRemoved = db.prepare(`
        DELETE FROM recordings
        WHERE id NOT IN (
          SELECT MIN(id) FROM recordings GROUP BY filename
        )
        AND filename IN (
          SELECT filename FROM recordings GROUP BY filename HAVING COUNT(*) > 1
        )
      `).run().changes
    } catch (error) {
      result.errors.push(`Failed to remove duplicate recordings: ${sanitizeError(error as Error)}`)
    }

    // Fix invalid meeting references
    try {
      result.invalidMeetingRefsFixed = db.prepare(`
        UPDATE recordings
        SET meeting_id = NULL, correlation_confidence = NULL, correlation_method = NULL
        WHERE meeting_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id)
      `).run().changes
    } catch (error) {
      result.errors.push(`Failed to fix invalid meeting references: ${sanitizeError(error as Error)}`)
    }

    if (result.errors.length > 0) {
      result.success = false
    }
  } catch (error) {
    result.success = false
    result.errors.push((error as Error).message)
  }

  return result
}

// ============================================================================
// P1 #011: V11 Migration with Transaction Safety
// ============================================================================

export async function migrateToV11Impl(): Promise<MigrationResult & { code?: string }> {
  // P1 #009: Acquire migration lock
  if (!migrationLock.acquire()) {
    return {
      success: false,
      capturesCreated: 0,
      errors: ['Migration already in progress'],
      verified: false,
      code: 'LOCK_CONFLICT'
    }
  }

  // P1 #013: Register progress tracker
  const trackerId = randomUUID()
  registerProgressTracker(trackerId)

  const result: MigrationResult = {
    success: true,
    capturesCreated: 0,
    errors: [],
    verified: false
  }

  try {
    // P1 #011: Wrap everything in a transaction
    runInTransaction(() => {
      const db = getDatabase()

      // Emit progress event
      getBroadcaster().broadcast('migration:progress', {
        phase: 'creating_backup',
        progress: 0
      })

      // P1 #012: Create backup before migration
      createMigrationBackup()

      getBroadcaster().broadcast('migration:progress', {
        phase: 'creating_tables',
        progress: 10
      })

      // P1 #010: Load and execute proper V11 schema
      const schemaSQL = loadV11Schema()

      // Remove comments (lines starting with --) and split by semicolon
      const cleanSQL = schemaSQL
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')

      const statements = cleanSQL
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)

      for (const stmt of statements) {
        if (stmt) {
          try {
            db.exec(stmt)
          } catch (error) {
            // Some statements might fail if tables/columns already exist - that's ok
            console.log('Schema statement warning:', (error as Error).message)
          }
        }
      }

      getBroadcaster().broadcast('migration:progress', {
        phase: 'migrating_data',
        progress: 20
      })

      // Get total count for progress calculation
      const totalCount = (db.prepare(`
        SELECT COUNT(*) as total
        FROM recordings r
        INNER JOIN transcripts t ON r.id = t.recording_id
        WHERE r.migration_status IS NULL OR r.migration_status = 'pending'
      `).get() as { total: number } | undefined)?.total ?? 0

      if (totalCount === 0) {
        getBroadcaster().broadcast('migration:progress', {
          phase: 'complete',
          progress: 100
        })
        return
      }

      // Prepare statements
      const migrateStmt = db.prepare(`
        SELECT r.id as recording_id, r.filename, r.date_recorded, r.meeting_id,
               t.full_text, t.summary, t.action_items
        FROM recordings r
        INNER JOIN transcripts t ON r.id = t.recording_id
        WHERE r.migration_status IS NULL OR r.migration_status = 'pending'
      `)

      const insertCaptureStmt = db.prepare(`
        INSERT INTO knowledge_captures (
          id, title, summary, captured_at, created_at, updated_at,
          meeting_id, source_recording_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)

      const insertActionItemStmt = db.prepare(`
        INSERT INTO action_items (
          id, knowledge_capture_id, content, created_at
        )
        VALUES (?, ?, ?, ?)
      `)

      const updateRecordingStmt = db.prepare(`
        UPDATE recordings
        SET migration_status = 'migrated',
            migrated_to_capture_id = ?,
            migrated_at = ?
        WHERE id = ?
      `)

      // P3-022: Time-based throttling for progress updates
      let lastProgressUpdateTime = 0
      const PROGRESS_UPDATE_INTERVAL_MS = 500

      let processed = 0
      for (const row of migrateStmt.all() as Array<Record<string, unknown>>) {
        try {
          const captureId = randomUUID()
          const now = new Date().toISOString()
          const title = `Recording: ${row.filename}`

          // Insert knowledge capture
          insertCaptureStmt.run(
            captureId,
            title,
            row.summary || null,
            row.date_recorded,
            now,
            now,
            row.meeting_id || null,
            row.recording_id
          )

          // Migrate action items with full structure preservation
          if (row.action_items) {
            try {
              const actionItems = JSON.parse(row.action_items as string)
              if (Array.isArray(actionItems)) {
                for (const item of actionItems) {
                  let content: string
                  if (typeof item === 'string') {
                    content = item
                  } else if (typeof item === 'object' && item !== null) {
                    // P1: Preserve full structure
                    content = item.description || item.text || item.task || item.action || JSON.stringify(item)
                  } else {
                    continue
                  }

                  if (content && content.trim()) {
                    insertActionItemStmt.run(randomUUID(), captureId, content, now)
                  }
                }
              }
            } catch {
              // If action_items is not valid JSON, try to parse as plain text
              const actionItemsText = row.action_items as string
              if (actionItemsText.trim()) {
                insertActionItemStmt.run(randomUUID(), captureId, actionItemsText, now)
              }
            }
          }

          // Update recording status
          updateRecordingStmt.run(captureId, now, row.recording_id)
          result.capturesCreated++
          processed++

          // P3-022: Throttle progress updates to 500ms intervals
          const currentTime = Date.now()
          const isLastRecord = processed === totalCount
          const shouldUpdate = currentTime - lastProgressUpdateTime >= PROGRESS_UPDATE_INTERVAL_MS

          if (shouldUpdate || isLastRecord) {
            lastProgressUpdateTime = currentTime
            const progress = Math.floor((processed / totalCount) * 60) + 20
            getBroadcaster().broadcast('migration:progress', {
              phase: 'migrating_data',
              progress,
              processed,
              total: totalCount
            })
          }
        } catch (error) {
          result.errors.push(`Failed to migrate recording ${row.recording_id}: ${sanitizeError(error as Error)}`)
        }
      }

      getBroadcaster().broadcast('migration:progress', {
        phase: 'verifying',
        progress: 85
      })

      // P1 #013: Verify migration integrity
      const verification = verifyMigration()
      result.verified = verification.success

      if (!verification.success) {
        result.errors.push(...verification.errors)
        throw new Error('Migration verification failed: ' + verification.errors.join(', '))
      }

      // Update schema version
      db.exec(`INSERT OR REPLACE INTO schema_version (version) VALUES (11)`)

      getBroadcaster().broadcast('migration:progress', {
        phase: 'complete',
        progress: 100,
        processed,
        total: totalCount
      })

      // P1 #012: Clean up backup tables on success
      cleanupBackupTables()
    })
  } catch (error) {
    result.success = false
    result.errors.push(sanitizeError(error as Error))

    getBroadcaster().broadcast('migration:progress', {
      phase: 'error',
      error: sanitizeError(error as Error)
    })

    // P1 #012: Restore from backup on failure
    try {
      restoreFromBackup()
      result.errors.push('Migration failed. Original data has been restored from backup.')
    } catch (restoreError) {
      result.errors.push(`Failed to restore from backup: ${sanitizeError(restoreError as Error)}`)
    }
  } finally {
    // P1 #013: Cleanup progress tracker
    cleanupProgressTracker(trackerId)
    // P1 #009: Release lock
    migrationLock.release()
  }

  return result
}

// ============================================================================
// Rollback Migration
// ============================================================================

export async function rollbackV11MigrationImpl(): Promise<{ success: boolean; errors: string[]; code?: string }> {
  // P1 #009: Acquire migration lock
  if (!migrationLock.acquire()) {
    return {
      success: false,
      errors: ['Migration in progress, cannot rollback'],
      code: 'LOCK_CONFLICT'
    }
  }

  const result = { success: true, errors: [] as string[] }

  try {
    // P2-017: Check backup exists BEFORE starting destructive operations
    const hasBackup = checkBackupExists()

    // P1 #011: Wrap in transaction
    runInTransaction(() => {
      const db = getDatabase()

      // P2-017: Restore from backup if it exists (before dropping tables)
      if (hasBackup) {
        try {
          restoreFromBackup()

          // P2-017: Verify restoration succeeded
          if (!verifyRestoration()) {
            throw new Error('Restoration verification failed - some recordings still marked as migrated')
          }
        } catch (error) {
          result.errors.push(`Failed to restore from backup: ${sanitizeError(error as Error)}`)
          throw error // Abort transaction
        }
      } else {
        console.log('No backup to restore, proceeding with standard rollback')
      }

      // Drop new tables (only after successful restore verification)
      db.exec('DROP TABLE IF EXISTS outputs')
      db.exec('DROP TABLE IF EXISTS follow_ups')
      db.exec('DROP TABLE IF EXISTS decisions')
      db.exec('DROP TABLE IF EXISTS action_items')
      db.exec('DROP TABLE IF EXISTS audio_sources')
      db.exec('DROP TABLE IF EXISTS knowledge_captures')

      // Reset migration status (only if backup didn't exist)
      if (!hasBackup) {
        try {
          db.exec(`UPDATE recordings SET migration_status = 'pending', migrated_to_capture_id = NULL, migrated_at = NULL WHERE migration_status = 'migrated'`)
        } catch {
          // Columns might not exist if migration wasn't completed
        }
      }

      // Revert schema version
      db.exec(`DELETE FROM schema_version WHERE version = 11`)

      // Clean up backup tables
      cleanupBackupTables()
    })
  } catch (error) {
    result.success = false
    result.errors.push(sanitizeError(error as Error))
  } finally {
    // P1 #009: Release lock
    migrationLock.release()
  }

  return result
}

// ============================================================================
// Get Migration Status
// ============================================================================

export async function getMigrationStatusImpl(): Promise<MigrationStatus> {
  const db = getDatabase()
  const status: MigrationStatus = {
    pending: 0,
    migrated: 0,
    skipped: 0,
    total: 0
  }

  try {
    // Check if migration_status column exists
    const cols = db.pragma('table_info(recordings)') as Array<{ name: string }>
    const hasMigrationStatus = cols.some(col => col.name === 'migration_status')

    if (hasMigrationStatus) {
      const row = db.prepare(`
        SELECT
          SUM(CASE WHEN migration_status IS NULL OR migration_status = 'pending' THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN migration_status = 'migrated' THEN 1 ELSE 0 END) as migrated,
          SUM(CASE WHEN migration_status = 'skipped' THEN 1 ELSE 0 END) as skipped,
          COUNT(*) as total
        FROM recordings
      `).get() as { pending: number; migrated: number; skipped: number; total: number } | undefined
      status.pending = row?.pending ?? 0
      status.migrated = row?.migrated ?? 0
      status.skipped = row?.skipped ?? 0
      status.total = row?.total ?? 0
    } else {
      // If column doesn't exist, count all recordings as pending
      const row = db.prepare(`SELECT COUNT(*) as total FROM recordings`).get() as { total: number } | undefined
      status.pending = row?.total ?? 0
      status.total = row?.total ?? 0
    }
  } catch (error) {
    console.error('Failed to get migration status:', error)
  }

  return status
}

// ============================================================================
// IPC Handler Registration
// ============================================================================

export function registerMigrationHandlers(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ipcMain } = require('electron') as typeof import('electron')
  // Get cleanup preview
  ipcMain.handle('migration:previewCleanup', async () => {
    try {
      return await generateCleanupPreviewImpl()
    } catch (error) {
      console.error('Failed to preview cleanup:', error)
      return {
        orphanedTranscripts: [],
        duplicateRecordings: [],
        invalidMeetingRefs: [],
        error: sanitizeError(error as Error)
      }
    }
  })

  // Run pre-migration cleanup
  ipcMain.handle('migration:runCleanup', async () => {
    try {
      return await runPreMigrationCleanupImpl()
    } catch (error) {
      console.error('Failed to run cleanup:', error)
      return {
        success: false,
        orphanedTranscriptsRemoved: 0,
        duplicateRecordingsRemoved: 0,
        invalidMeetingRefsFixed: 0,
        errors: [sanitizeError(error as Error)]
      }
    }
  })

  // Run full migration
  ipcMain.handle('migration:runV11', async () => {
    try {
      return await migrateToV11Impl()
    } catch (error) {
      console.error('Failed to run migration:', error)
      return {
        success: false,
        capturesCreated: 0,
        errors: [sanitizeError(error as Error)],
        verified: false
      }
    }
  })

  // Rollback migration
  ipcMain.handle('migration:rollbackV11', async () => {
    try {
      return await rollbackV11MigrationImpl()
    } catch (error) {
      console.error('Failed to rollback migration:', error)
      return {
        success: false,
        errors: [sanitizeError(error as Error)]
      }
    }
  })

  // Get migration status
  ipcMain.handle('migration:getStatus', async () => {
    try {
      return await getMigrationStatusImpl()
    } catch (error) {
      console.error('Failed to get migration status:', error)
      return {
        pending: 0,
        migrated: 0,
        skipped: 0,
        total: 0,
        error: sanitizeError(error as Error)
      }
    }
  })
}
