/**
 * migration.ts — REST SDK group for the migration namespace (0c-5 admin routes).
 *
 * Per CONTRACTS.md (Migration table) all methods are RAW-THROW.
 * No renderer call sites — invoked from main/bootstrap, not `src`.
 * Classified by type signature per CONTRACTS instructions.
 *
 * NOTE: migration.onProgress is wired via the events group (makeEventsGroup); this
 *       group is merged shallowly into the migration namespace so onProgress is
 *       already present when index.ts composes — do NOT define it here.
 */

import type { Http } from '../http'
import type {
  MigrationCleanupPreview,
  MigrationCleanupResult,
  MigrationResult,
  MigrationRollbackResult,
  MigrationStatus,
} from '../../../../electron/preload/migration-types'

export interface MigrationDeps {
  http: Http
}

export function makeMigrationGroup({ http }: MigrationDeps) {
  return {
    // -------------------------------------------------------------------------
    // RAW-THROW: getStatus
    // -------------------------------------------------------------------------

    async getStatus(): Promise<MigrationStatus> {
      const r = await http.get('/api/migration/status')
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data as MigrationStatus
    },

    // -------------------------------------------------------------------------
    // RAW-THROW: previewCleanup
    // -------------------------------------------------------------------------

    async previewCleanup(): Promise<MigrationCleanupPreview> {
      const r = await http.get('/api/migration/preview')
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data as MigrationCleanupPreview
    },

    // -------------------------------------------------------------------------
    // RAW-THROW: runCleanup
    // NOTE: success here is a data field (bare body), NOT a Result envelope.
    // -------------------------------------------------------------------------

    async runCleanup(): Promise<MigrationCleanupResult> {
      const r = await http.post('/api/migration/run-cleanup')
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data as MigrationCleanupResult
    },

    // -------------------------------------------------------------------------
    // RAW-THROW: runV11
    // -------------------------------------------------------------------------

    async runV11(): Promise<MigrationResult> {
      const r = await http.post('/api/migration/run-v11')
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data as MigrationResult
    },

    // -------------------------------------------------------------------------
    // RAW-THROW: rollbackV11
    // -------------------------------------------------------------------------

    async rollbackV11(): Promise<MigrationRollbackResult> {
      const r = await http.post('/api/migration/rollback-v11')
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data as MigrationRollbackResult
    },
  }
}

export type MigrationGroupRest = ReturnType<typeof makeMigrationGroup>
