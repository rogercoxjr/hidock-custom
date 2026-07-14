/**
 * events.test.ts — Shape-assertion tests for the events SDK group.
 *
 * For every EVENT method we assert two things:
 *   1. wsClient.subscribe is called with the EXACT verbatim channel string
 *      from electron/preload/index.ts / CONTRACTS.md.
 *   2. The callback is forwarded unchanged (payload identity).
 *
 * There are no 2xx/4xx HTTP fixtures here — EVENT methods never call fetch.
 */

import { describe, it, expect, vi, type Mock } from 'vitest'
import { makeEventsGroup, type EventsGroup } from '../groups/events'
import type { WsClient } from '../ws'

// ---------------------------------------------------------------------------
// Mock WsClient
// ---------------------------------------------------------------------------

function makeMockWs(): { ws: WsClient & { subscribe: Mock }; group: EventsGroup } {
  const subscribe = vi.fn((_channel: string, _cb: (p: unknown) => void) => {
    // Return a no-op unsubscribe
    return () => {}
  })
  const ws = { subscribe } as unknown as WsClient & { subscribe: Mock }
  const group = makeEventsGroup({ wsClient: ws })
  return { ws, group }
}

// ---------------------------------------------------------------------------
// Helper: subscribe-call shape assertion
// Each test:
//   1. Calls the method with a spy callback.
//   2. Asserts subscribe was called with the exact channel.
//   3. Asserts the returned value is a function (the unsubscribe token).
//   4. Simulates the WS broadcast by calling the stored subscriber and
//      verifies the callback receives the payload unchanged.
// ---------------------------------------------------------------------------

function assertEvent(
  invoke: (group: EventsGroup, cb: (payload: any) => void) => () => void,
  expectedChannel: string,
) {
  const { ws, group } = makeMockWs()
  const cb = vi.fn()

  const unsub = invoke(group, cb)

  // 1. subscribe called with verbatim channel
  expect(ws.subscribe).toHaveBeenCalledWith(expectedChannel, expect.any(Function))

  // 2. unsub is a function
  expect(typeof unsub).toBe('function')

  // 3. payload is forwarded unchanged
  const [, subscriber] = ws.subscribe.mock.calls[0] as [string, (p: unknown) => void]
  const payload = { foo: 'bar', count: 42 }
  subscriber(payload)
  expect(cb).toHaveBeenCalledWith(payload)
}

describe('makeEventsGroup', () => {
  // -------------------------------------------------------------------------
  // Top-level on* methods
  // -------------------------------------------------------------------------

  it('onDomainEvent → channel "domain-event"', () => {
    assertEvent((g, cb) => g.onDomainEvent(cb), 'domain-event')
  })

  it('onRecordingAdded → channel "recording:new" (PHASE-1)', () => {
    assertEvent((g, cb) => g.onRecordingAdded(cb), 'recording:new')
  })

  it('onTranscriptionStarted → channel "transcription:started"', () => {
    assertEvent((g, cb) => g.onTranscriptionStarted(cb), 'transcription:started')
  })

  it('onTranscriptionProgress → channel "transcription:progress"', () => {
    assertEvent((g, cb) => g.onTranscriptionProgress(cb), 'transcription:progress')
  })

  it('onTranscriptionCompleted → channel "transcription:completed"', () => {
    assertEvent((g, cb) => g.onTranscriptionCompleted(cb), 'transcription:completed')
  })

  it('onTranscriptionFailed → channel "transcription:failed"', () => {
    assertEvent((g, cb) => g.onTranscriptionFailed(cb), 'transcription:failed')
  })

  it('onTranscriptionCancelled → channel "transcription:cancelled"', () => {
    assertEvent((g, cb) => g.onTranscriptionCancelled(cb), 'transcription:cancelled')
  })

  it('onTranscriptionAllCancelled → channel "transcription:all-cancelled"', () => {
    assertEvent((g, cb) => g.onTranscriptionAllCancelled(cb), 'transcription:all-cancelled')
  })

  it('onSecurityWarning is a no-op in hosted mode (Electron-desktop-only; no /ws subscribe)', () => {
    // security-warning fires only on desktop via preload IPC (remote-debugging warning); there is
    // no /ws publisher, so the hosted SDK must NOT subscribe over /ws (keeps the ws-contract honest).
    // It still returns a valid no-op unsub so the shared SecurityWarningBanner keeps working.
    const { ws, group } = makeMockWs()
    const unsub = group.onSecurityWarning(vi.fn())
    expect(ws.subscribe).not.toHaveBeenCalled()
    expect(typeof unsub).toBe('function')
    expect(() => unsub()).not.toThrow()
  })

  it('onActivityLogEntry → channel "activity-log:entry"', () => {
    assertEvent((g, cb) => g.onActivityLogEntry(cb), 'activity-log:entry')
  })

  it('onVoiceprintCaptured → channel "voiceprint:captured"', () => {
    assertEvent((g, cb) => g.onVoiceprintCaptured(cb), 'voiceprint:captured')
  })

  it('onConnectionRestored → reserved channel "connection:reconnected"', () => {
    // Bespoke (not assertEvent): this callback takes no payload argument.
    const { ws, group } = makeMockWs()
    const cb = vi.fn()

    const unsub = group.onConnectionRestored(cb)

    expect(ws.subscribe).toHaveBeenCalledWith('connection:reconnected', expect.any(Function))
    expect(typeof unsub).toBe('function')

    const [, subscriber] = ws.subscribe.mock.calls[0] as [string, (p: unknown) => void]
    subscriber(undefined)
    expect(cb).toHaveBeenCalledOnce()
  })

  // -------------------------------------------------------------------------
  // Nested group partials
  // -------------------------------------------------------------------------

  it('integrity.onProgress → channel "integrity:progress"', () => {
    assertEvent((g, cb) => g.integrity.onProgress(cb), 'integrity:progress')
  })

  it('migration.onProgress → channel "migration:progress"', () => {
    assertEvent((g, cb) => g.migration.onProgress(cb), 'migration:progress')
  })

  it('downloadService.onStateUpdate → channel "download-service:state-update" (PHASE-1)', () => {
    assertEvent((g, cb) => g.downloadService.onStateUpdate(cb), 'download-service:state-update')
  })

  // -------------------------------------------------------------------------
  // Unsubscribe: calling the returned token removes the listener (smoke test)
  // -------------------------------------------------------------------------

  it('unsubscribe token is callable without error', () => {
    const { group } = makeMockWs()
    const unsub = group.onDomainEvent(vi.fn())
    expect(() => unsub()).not.toThrow()
  })
})
