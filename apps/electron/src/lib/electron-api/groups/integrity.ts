/**
 * integrity.ts — REST SDK group for the integrity namespace (0c-5 admin routes).
 *
 * Per CONTRACTS.md (Integrity table):
 *
 *   runScan             — RAW-THROW: bare scan report; `setReport(result)` at call site
 *   getReport           — RAW-THROW: bare `any`
 *   repairIssue         — INLINE: `{issueId, success, action, error?}` (no renderer call site)
 *   repairAll           — INLINE-array: `Array<{issueId, success, action, error?}>`;
 *                         `setRepairResults(results)` at HealthCheck.tsx:83
 *   runStartupChecks    — RAW-THROW: bare `{issuesFound, issuesFixed}`
 *   cleanupWronglyNamed — RAW-THROW: bare `{deletedFiles, keptFiles, clearedDbRecords}`
 *   purgeMissingFiles   — RAW-THROW: bare `{totalRecords, deleted, kept, deletedFiles}`
 *
 * NOTE: integrity.onProgress is wired via the events group (makeEventsGroup); this
 *       group is merged shallowly into the integrity namespace so onProgress is
 *       already present when index.ts composes — do NOT define it here.
 */

import type { Http } from '../http'

export interface IntegrityDeps {
  http: Http
}

export function makeIntegrityGroup({ http }: IntegrityDeps) {
  return {
    // -------------------------------------------------------------------------
    // RAW-THROW: runScan
    // -------------------------------------------------------------------------

    async runScan(): Promise<{
      scanStarted: string
      scanCompleted: string
      totalIssues: number
      issuesByType: Record<string, number>
      issuesBySeverity: Record<string, number>
      issues: Array<{
        id: string
        type: string
        severity: 'low' | 'medium' | 'high'
        description: string
        filePath?: string
        filename?: string
        recordingId?: string
        suggestedAction: string
        autoRepairable: boolean
        details?: Record<string, unknown>
      }>
      autoRepairableCount: number
    }> {
      const r = await http.post('/api/integrity/run-scan')
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data as any
    },

    // -------------------------------------------------------------------------
    // RAW-THROW: getReport
    // -------------------------------------------------------------------------

    async getReport(): Promise<any> {
      const r = await http.get('/api/integrity/report')
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data
    },

    // -------------------------------------------------------------------------
    // INLINE: repairIssue — no renderer call site; classified by type
    // -------------------------------------------------------------------------

    async repairIssue(issueId: string): Promise<{
      issueId: string
      success: boolean
      action: string
      error?: string
    }> {
      const r = await http.post('/api/integrity/repair-issue', { issueId })
      if (!r.ok) {
        return {
          issueId,
          success: false,
          action: 'repair',
          error: r.error ?? `HTTP ${r.status}`,
        }
      }
      return r.data as { issueId: string; success: boolean; action: string; error?: string }
    },

    // -------------------------------------------------------------------------
    // INLINE-array: repairAll — call site reads setRepairResults(results)
    // -------------------------------------------------------------------------

    async repairAll(): Promise<
      Array<{
        issueId: string
        success: boolean
        action: string
        error?: string
      }>
    > {
      const r = await http.post('/api/integrity/repair-all')
      if (!r.ok) {
        // Return an array with a single failure entry matching the inline shape.
        return [
          {
            issueId: 'unknown',
            success: false,
            action: 'repair-all',
            error: r.error ?? `HTTP ${r.status}`,
          },
        ]
      }
      // Guard against non-array server responses; wrap single objects so the
      // caller (setRepairResults) always receives an array.
      const raw = r.data
      const results: Array<{ issueId: string; success: boolean; action: string; error?: string }> =
        Array.isArray(raw)
          ? (raw as Array<{ issueId: string; success: boolean; action: string; error?: string }>)
          : [raw as { issueId: string; success: boolean; action: string; error?: string }]
      return results
    },

    // -------------------------------------------------------------------------
    // RAW-THROW: runStartupChecks
    // -------------------------------------------------------------------------

    async runStartupChecks(): Promise<{ issuesFound: number; issuesFixed: number }> {
      const r = await http.post('/api/integrity/run-startup-checks')
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data as { issuesFound: number; issuesFixed: number }
    },

    // -------------------------------------------------------------------------
    // RAW-THROW: cleanupWronglyNamed
    // -------------------------------------------------------------------------

    async cleanupWronglyNamed(): Promise<{
      deletedFiles: string[]
      keptFiles: string[]
      clearedDbRecords: number
    }> {
      const r = await http.post('/api/integrity/cleanup-wrongly-named')
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data as { deletedFiles: string[]; keptFiles: string[]; clearedDbRecords: number }
    },

    // -------------------------------------------------------------------------
    // RAW-THROW: purgeMissingFiles
    // -------------------------------------------------------------------------

    async purgeMissingFiles(): Promise<{
      totalRecords: number
      deleted: number
      kept: number
      deletedFiles: string[]
    }> {
      const r = await http.post('/api/integrity/purge-missing-files')
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data as {
        totalRecords: number
        deleted: number
        kept: number
        deletedFiles: string[]
      }
    },
  }
}

export type IntegrityGroup = ReturnType<typeof makeIntegrityGroup>
