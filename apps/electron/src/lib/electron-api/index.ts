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
import { makeMeetingsGroup } from './groups/meetings'
import { makeContactsGroup } from './groups/contacts'
import { makeProjectsGroup } from './groups/projects'
import { makeKnowledgeGroup } from './groups/knowledge'
import { makeSyncedFilesGroup } from './groups/syncedFiles'
import { makeChatGroup } from './groups/chat'
import { makeCalendarGroup } from './groups/calendar'
import { makeRagGroup } from './groups/rag'
import { makeAssistantGroup } from './groups/assistant'
import { makeActionablesGroup } from './groups/actionables'
import { makeOutputsGroup } from './groups/outputs'
import { makeSummarizationGroup } from './groups/summarization'
import { makeSummarizationTemplatesGroup } from './groups/summarizationTemplates'
import { makeQualityGroup } from './groups/quality'
import { makeStorageGroup } from './groups/storage'
import { makeConfigGroup } from './groups/config'
import { makeVoiceprintsGroup } from './groups/voiceprints'
import { makeSpeakersGroup } from './groups/speakers'
import { makeDiarizationGroup } from './groups/diarization'
import { makeIntegrityGroup } from './groups/integrity'
import { makeAppInfoGroup } from './groups/appInfo'
import { makeDeviceCacheGroup } from './groups/deviceCache'
import { makeStoragePolicyGroup } from './groups/storagePolicy'
import { makeMigrationGroup } from './groups/migration'
import { makeDeviceGroup } from './groups/device'
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

  // --- Task 6 (people-time): meetings / contacts / projects / knowledge / syncedFiles / chat / calendar ---
  Object.assign(api, {
    meetings: makeMeetingsGroup({ http: httpTransport }),
    contacts: makeContactsGroup({ http: httpTransport }),
    projects: makeProjectsGroup({ http: httpTransport }),
    knowledge: makeKnowledgeGroup({ http: httpTransport }),
    syncedFiles: makeSyncedFilesGroup({ http: httpTransport }),
    chat: makeChatGroup({ http: httpTransport }),
    calendar: makeCalendarGroup({ http: httpTransport }),
  })

  // --- Task 7 (ai-outputs): rag / assistant / actionables / outputs / summarization / summarizationTemplates / quality ---
  Object.assign(api, {
    rag: makeRagGroup({ http: httpTransport }),
    assistant: makeAssistantGroup({ http: httpTransport }),
    actionables: makeActionablesGroup({ http: httpTransport }),
    outputs: makeOutputsGroup({ http: httpTransport }),
    summarization: makeSummarizationGroup({ http: httpTransport }),
    summarizationTemplates: makeSummarizationTemplatesGroup({ http: httpTransport }),
    quality: makeQualityGroup({ http: httpTransport }),
  })

  // --- Task 8 (infra-voice): storage / config / voiceprints / speakers / diarization /
  //     integrity / app / deviceCache / storagePolicy / migration ---
  Object.assign(api, {
    storage: makeStorageGroup({ http: httpTransport }),
    config: makeConfigGroup({ http: httpTransport }),
    voiceprints: makeVoiceprintsGroup({ http: httpTransport }),
    speakers: makeSpeakersGroup({ http: httpTransport }),
    diarization: makeDiarizationGroup({ http: httpTransport }),
    deviceCache: makeDeviceCacheGroup({ http: httpTransport }),
    storagePolicy: makeStoragePolicyGroup({ http: httpTransport }),
  })

  // Merge infra REST methods into the partially-seeded namespaces from the events group.
  // Object.assign(api.integrity, ...) preserves the onProgress event already set.
  Object.assign(api.integrity, makeIntegrityGroup({ http: httpTransport }))
  Object.assign(api.migration, makeMigrationGroup({ http: httpTransport }))

  // app group: seed restart (no-op) + info (RAW-THROW).
  Object.assign(api, { app: makeAppInfoGroup({ http: httpTransport }) })

  // --- Task 9: device stubs (PHASE-1 — no REST endpoints) ---
  // jensen is a new namespace; downloadService.onStateUpdate is already seeded by the
  // events group so we merge the remaining 18 method stubs into that partial object.
  const deviceGroup = makeDeviceGroup()
  Object.assign(api, { jensen: deviceGroup.jensen })
  Object.assign(api.downloadService, deviceGroup.downloadService)

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
