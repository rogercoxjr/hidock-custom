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
import { WsClient } from './ws'
import { makeEventsGroup } from './groups/events'
import { makeRecordingsGroup } from './groups/recordings'
import { makeTranscriptsGroup } from './groups/transcripts'
import { makeQueueGroup } from './groups/queue'
import { http as httpTransport } from './http'

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

  // Shared WebSocket client (singleton per SDK instance).
  const wsClient = new WsClient()

  // --- Task 4: events group (all on* / onProgress / onStateUpdate methods) ---
  const eventsGroup = makeEventsGroup({ wsClient })
  // Spread top-level on* keys onto the api root.
  Object.assign(api, {
    onDomainEvent: eventsGroup.onDomainEvent,
    onRecordingAdded: eventsGroup.onRecordingAdded,
    onTranscriptionStarted: eventsGroup.onTranscriptionStarted,
    onTranscriptionProgress: eventsGroup.onTranscriptionProgress,
    onTranscriptionCompleted: eventsGroup.onTranscriptionCompleted,
    onTranscriptionFailed: eventsGroup.onTranscriptionFailed,
    onTranscriptionCancelled: eventsGroup.onTranscriptionCancelled,
    onTranscriptionAllCancelled: eventsGroup.onTranscriptionAllCancelled,
    onSecurityWarning: eventsGroup.onSecurityWarning,
    onActivityLogEntry: eventsGroup.onActivityLogEntry,
    onVoiceprintCaptured: eventsGroup.onVoiceprintCaptured,
    // Nested group partials (merged shallowly; later REST group tasks fill the rest
    // of these namespaces — event methods are seeded here first so they're present
    // even before other groups are composed).
    integrity: { ...eventsGroup.integrity },
    migration: { ...eventsGroup.migration },
    downloadService: { ...eventsGroup.downloadService },
  })

  // --- Task 5: recordings / transcripts / queue groups ---
  Object.assign(api, {
    recordings: makeRecordingsGroup({ http: httpTransport }),
    transcripts: makeTranscriptsGroup({ http: httpTransport }),
    queue: makeQueueGroup({ http: httpTransport }),
  })

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
