/**
 * appInfo.ts — REST SDK group for the app namespace (0c-5).
 *
 * Per CONTRACTS.md (Top-level App / Config table):
 *
 *   app.info    — RAW-THROW: `GET /api/app/info`; bare `{version, name, isPackaged, platform}`
 *                 Call site: `Layout.tsx:119` — `.then((info) => …)`
 *   app.restart — DROPPED (0c §4: no desktop relaunch); no-op resolve (void)
 */

import type { Http } from '../http'

export interface AppInfoDeps {
  http: Http
}

export function makeAppInfoGroup({ http }: AppInfoDeps) {
  return {
    // -------------------------------------------------------------------------
    // RAW-THROW: info
    // -------------------------------------------------------------------------

    async info(): Promise<{
      version: string
      name: string
      isPackaged: boolean
      platform: string
    }> {
      const r = await http.get('/api/app/info')
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data as { version: string; name: string; isPackaged: boolean; platform: string }
    },

    // -------------------------------------------------------------------------
    // DROPPED: restart — no-op resolve
    // -------------------------------------------------------------------------

    async restart(): Promise<void> {
      // No server-side relaunch available in browser mode (0c §4 — DROPPED).
    },
  }
}

export type AppInfoGroup = ReturnType<typeof makeAppInfoGroup>
