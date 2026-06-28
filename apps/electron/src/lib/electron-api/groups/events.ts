/**
 * events.ts — EVENT subscriptions group for the renderer REST SDK.
 *
 * All top-level on* methods plus group-nested onProgress/onStateUpdate handlers.
 * Every method delegates directly to wsClient.subscribe(<verbatim-channel>, cb)
 * and returns the () => void unsubscribe token.
 *
 * PHASE-1 events (onRecordingAdded, downloadService.onStateUpdate) follow the same
 * pattern: wire to /ws if the broadcaster emits on that channel; the no-op-unsub
 * fallback is not needed because the WS multiplexer simply never fires a callback
 * that has no publisher — the unsubscribe function is always valid.
 *
 * Classifications (per CONTRACTS.md EVENT table):
 *   domain-event, transcription:*, security-warning, activity-log:entry,
 *   voiceprint:captured, integrity:progress, migration:progress,
 *   recording:new, download-service:state-update
 */

import type { WsClient } from '../ws'
import type { MigrationProgress } from '../../../../electron/preload/migration-types'

export interface EventsDeps {
  wsClient: WsClient
}

/**
 * Shape returned by makeEventsGroup — the flat top-level on* keys plus
 * the nested group keys that hold onProgress/onStateUpdate.
 *
 * The outer ElectronAPI spreads these at the top level (and nested) via
 * Object.assign; integrity/migration/downloadService groups fill their own
 * non-event methods — this group only contributes the event methods onto
 * those namespaces.
 */
export interface EventsGroup {
  // Top-level EVENT methods (on* on ElectronAPI root)
  onDomainEvent: (callback: (event: any) => void) => () => void
  onRecordingAdded: (callback: (data: { recording: any }) => void) => () => void
  onTranscriptionStarted: (callback: (data: { queueItemId?: string; recordingId: string }) => void) => () => void
  onTranscriptionProgress: (callback: (data: { queueItemId: string; progress: number; stage: string }) => void) => () => void
  onTranscriptionCompleted: (callback: (data: { queueItemId?: string; recordingId: string }) => void) => () => void
  onTranscriptionFailed: (callback: (data: { queueItemId?: string; recordingId: string; error: string }) => void) => () => void
  onTranscriptionCancelled: (callback: (data: { recordingId: string }) => void) => () => void
  onTranscriptionAllCancelled: (callback: (data: { count: number }) => void) => () => void
  onSecurityWarning: (callback: (data: { type: string; message: string }) => void) => () => void
  onActivityLogEntry: (callback: (entry: { type: string; message: string; details?: string; timestamp: string }) => void) => () => void
  onVoiceprintCaptured: (callback: (data: {
    recordingId: string
    fileLabel: string
    contactId: string
    captured: boolean
    reason?: string
    cleanSpeechMs?: number
    voiceprintId?: string
    purgedPriorContactId?: string
    purgedCount?: number
  }) => void) => () => void

  // Nested group partial — integrity.onProgress
  integrity: {
    onProgress: (callback: (progress: { message: string; progress: number }) => void) => () => void
  }

  // Nested group partial — migration.onProgress
  migration: {
    onProgress: (callback: (progress: MigrationProgress) => void) => () => void
  }

  // Nested group partial — downloadService.onStateUpdate (PHASE-1 / EVENT)
  downloadService: {
    onStateUpdate: (callback: (state: any) => void) => () => void
  }
}

/**
 * Factory: returns all EVENT methods wired to wsClient.subscribe().
 *
 * Call at installRestApi() time; spread result with Object.assign so top-level
 * keys land on the root api and nested keys merge into their groups.
 *
 * NOTE: Object.assign does a shallow merge so integrity/migration/downloadService
 * must be composed carefully — spread each nested group AFTER the REST group
 * factory has already set up its non-event methods.  The compose call in
 * index.ts handles this by merging deeply or by composing in the right order.
 */
export function makeEventsGroup({ wsClient }: EventsDeps): EventsGroup {
  return {
    // -------------------------------------------------------------------------
    // Top-level on* (CONTRACTS EVENT table rows 1–9 + PHASE-1 rows)
    // -------------------------------------------------------------------------

    onDomainEvent: (cb) => wsClient.subscribe('domain-event', cb as (p: unknown) => void),

    // PHASE-1: wire to recording:new on /ws (no-op unsub is never needed because
    // WsClient.subscribe always returns a valid unsub).
    onRecordingAdded: (cb) => wsClient.subscribe('recording:new', cb as (p: unknown) => void),

    onTranscriptionStarted: (cb) => wsClient.subscribe('transcription:started', cb as (p: unknown) => void),
    onTranscriptionProgress: (cb) => wsClient.subscribe('transcription:progress', cb as (p: unknown) => void),
    onTranscriptionCompleted: (cb) => wsClient.subscribe('transcription:completed', cb as (p: unknown) => void),
    onTranscriptionFailed: (cb) => wsClient.subscribe('transcription:failed', cb as (p: unknown) => void),
    onTranscriptionCancelled: (cb) => wsClient.subscribe('transcription:cancelled', cb as (p: unknown) => void),
    onTranscriptionAllCancelled: (cb) => wsClient.subscribe('transcription:all-cancelled', cb as (p: unknown) => void),

    onSecurityWarning: (cb) => wsClient.subscribe('security-warning', cb as (p: unknown) => void),
    onActivityLogEntry: (cb) => wsClient.subscribe('activity-log:entry', cb as (p: unknown) => void),
    onVoiceprintCaptured: (cb) => wsClient.subscribe('voiceprint:captured', cb as (p: unknown) => void),

    // -------------------------------------------------------------------------
    // Nested group partial — integrity.onProgress
    // -------------------------------------------------------------------------
    integrity: {
      onProgress: (cb) => wsClient.subscribe('integrity:progress', cb as (p: unknown) => void),
    },

    // -------------------------------------------------------------------------
    // Nested group partial — migration.onProgress
    // -------------------------------------------------------------------------
    migration: {
      onProgress: (cb) => wsClient.subscribe('migration:progress', cb as (p: unknown) => void),
    },

    // -------------------------------------------------------------------------
    // Nested group partial — downloadService.onStateUpdate (PHASE-1 / EVENT)
    // -------------------------------------------------------------------------
    downloadService: {
      onStateUpdate: (cb) => wsClient.subscribe('download-service:state-update', cb as (p: unknown) => void),
    },
  }
}
