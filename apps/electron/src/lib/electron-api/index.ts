/**
 * index.ts — REST SDK bootstrap.
 *
 * `installRestApi()` builds the `ElectronAPI` object backed by fetch/WebSocket
 * (instead of ipcRenderer.invoke) and assigns it to `window.electronAPI`.
 *
 * The object starts as an empty cast (`{} as ElectronAPI`).  Later tasks
 * add method groups via `Object.assign(api, makeXxxGroup(http), …)`.
 *
 * Usage (renderer entry point, before React tree mounts):
 *   import { installRestApi } from '@lib/electron-api'
 *   installRestApi()
 */

import type { ElectronAPI } from './types'

export type { ElectronAPI } from './types'
export { http } from './http'
export type { Http, HttpResult } from './http'
export { setOnUnauthorized } from './http'

/** The live SDK instance — populated by installRestApi(). */
export let restApi: ElectronAPI

/**
 * Build the ElectronAPI object, assign it to `window.electronAPI`, and return it.
 * Call once at renderer bootstrap before the React tree mounts.
 *
 * Method groups are composed here via Object.assign as later tasks implement them.
 * Until then, the cast is safe because no group code runs during tests of the skeleton.
 */
export function installRestApi(): ElectronAPI {
  // Start with an empty object cast to ElectronAPI.
  // Each subsequent task adds a group:
  //   Object.assign(api, makeRecordingsGroup(http))
  //   Object.assign(api, makeContactsGroup(http))
  //   …
  const api = {} as ElectronAPI

  // Assign to window so all existing call sites (`window.electronAPI.<group>.<method>`)
  // pick up the REST SDK without modification.
  if (typeof window !== 'undefined') {
    ;(window as any).electronAPI = api
  }

  restApi = api
  return api
}

// Re-export the http helpers directly so group factories can import them from one place.
export { get, post, patch, put, del } from './http'
