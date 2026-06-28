/**
 * config.ts — REST SDK group for the config namespace (0c-5).
 *
 * Per CONTRACTS.md (Top-level App / Config table):
 *
 *   config.get           — RESULT; call site reads `result.success` / `result.data` / `result.error?.message`
 *   config.set           — RESULT; same envelope
 *   config.updateSection — RESULT; call site reads `result.success` / `result.data` / `result.error?.message`
 *   config.getValue      — RAW-THROW; bare value
 *
 * ERROR-OBJECT SYNTHESIS (CONTRACTS §error-detail):
 *   result.error = { message: r.error, details: (r.data as any)?.details }
 *   Call sites read `result.error?.message`.
 */

import type { Http } from '../http'

export interface ConfigDeps {
  http: Http
}

/** Synthesise an error object for call sites that read `result.error?.message`. */
function errObj(r: { error?: string; data?: unknown }): { message: string; details?: unknown } {
  return {
    message: r.error ?? 'Unknown error',
    details: (r.data as any)?.details,
  }
}

export function makeConfigGroup({ http }: ConfigDeps) {
  return {
    // -------------------------------------------------------------------------
    // RESULT: get
    // -------------------------------------------------------------------------

    async get(): Promise<any> {
      const r = await http.get('/api/config')
      if (!r.ok) {
        return { success: false, error: errObj(r) }
      }
      return { success: true, data: r.data }
    },

    // -------------------------------------------------------------------------
    // RESULT: set
    // -------------------------------------------------------------------------

    async set(config: any): Promise<any> {
      const r = await http.patch('/api/config', config)
      if (!r.ok) {
        return { success: false, error: errObj(r) }
      }
      return { success: true, data: r.data }
    },

    // -------------------------------------------------------------------------
    // RESULT: updateSection
    // -------------------------------------------------------------------------

    async updateSection(section: string, values: any): Promise<any> {
      const r = await http.patch('/api/config', { [section]: values })
      if (!r.ok) {
        return { success: false, error: errObj(r) }
      }
      return { success: true, data: r.data }
    },

    // -------------------------------------------------------------------------
    // RAW-THROW: getValue
    // -------------------------------------------------------------------------

    async getValue(key: string): Promise<any> {
      const r = await http.get(`/api/config?key=${encodeURIComponent(key)}`)
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data
    },
  }
}

export type ConfigGroup = ReturnType<typeof makeConfigGroup>
