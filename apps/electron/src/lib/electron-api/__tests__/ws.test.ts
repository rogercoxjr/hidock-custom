/**
 * ws.test.ts — WsClient event multiplexer unit tests.
 *
 * Uses a FakeWS class stubbed via `vi.stubGlobal('WebSocket', FakeWS)` so the
 * real WebSocket API is never contacted.  Fake timers drive the reconnect backoff.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WsClient } from '../ws'

// ---------------------------------------------------------------------------
// FakeWS — a minimal WebSocket stand-in that records calls and lets tests
// drive events imperatively.
// ---------------------------------------------------------------------------
class FakeWS {
  static instances: FakeWS[] = []

  url: string
  readyState: number = 1 // OPEN
  onopen: (() => void) | null = null
  onclose: ((ev: { code: number; reason: string; wasClean: boolean }) => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null

  private _sentMessages: string[] = []

  constructor(url: string) {
    this.url = url
    FakeWS.instances.push(this)
    // Simulate async open (fires after construction settles)
    Promise.resolve().then(() => this.onopen?.())
  }

  send(data: string) {
    this._sentMessages.push(data)
  }

  close() {
    this.readyState = 3 // CLOSED
  }

  /** Helper: push a raw data frame as if the server sent it. */
  emit(data: string) {
    this.onmessage?.({ data })
  }

  /** Helper: trigger close (simulating server disconnect). */
  triggerClose(code = 1006, reason = '', wasClean = false) {
    this.readyState = 3
    this.onclose?.({ code, reason, wasClean })
  }
}

describe('WsClient', () => {
  beforeEach(() => {
    FakeWS.instances = []
    vi.stubGlobal('WebSocket', FakeWS)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  // -------------------------------------------------------------------------
  // 1. subscribe + frame dispatching — exact payload pass-through
  // -------------------------------------------------------------------------
  it('dispatches exact payload to a subscribed channel callback', async () => {
    const client = new WsClient()
    const cb = vi.fn()

    client.subscribe('transcription:progress', cb)

    // Allow FakeWS onopen to fire
    await Promise.resolve()

    const ws = FakeWS.instances[0]
    expect(ws).toBeDefined()

    ws.emit(JSON.stringify({
      channel: 'transcription:progress',
      payload: { queueItemId: 'q1', progress: 42, stage: 'asr' },
    }))

    expect(cb).toHaveBeenCalledOnce()
    expect(cb).toHaveBeenCalledWith({ queueItemId: 'q1', progress: 42, stage: 'asr' })
  })

  // -------------------------------------------------------------------------
  // 2. Two subscribers to same channel — both fire; unsubscribe removes only one
  // -------------------------------------------------------------------------
  it('fires both subscribers on the same channel; returned unsubscribe removes only that one', async () => {
    const client = new WsClient()
    const cbA = vi.fn()
    const cbB = vi.fn()

    client.subscribe('transcription:progress', cbA)
    const unsubB = client.subscribe('transcription:progress', cbB)

    await Promise.resolve()

    const ws = FakeWS.instances[0]
    const frame = JSON.stringify({
      channel: 'transcription:progress',
      payload: { queueItemId: 'q2', progress: 10, stage: 'upload' },
    })

    ws.emit(frame)
    expect(cbA).toHaveBeenCalledOnce()
    expect(cbB).toHaveBeenCalledOnce()

    // Unsubscribe B
    unsubB()

    cbA.mockClear()
    cbB.mockClear()

    ws.emit(frame)
    expect(cbA).toHaveBeenCalledOnce()   // A still fires
    expect(cbB).not.toHaveBeenCalled()   // B is gone
  })

  // -------------------------------------------------------------------------
  // 3. Frame for unsubscribed channel — ignored, no throw
  // -------------------------------------------------------------------------
  it('ignores frames for channels with no subscribers (no throw)', async () => {
    const client = new WsClient()
    client.subscribe('transcription:progress', vi.fn())

    await Promise.resolve()

    const ws = FakeWS.instances[0]
    expect(() =>
      ws.emit(JSON.stringify({ channel: 'some:other:channel', payload: { x: 1 } }))
    ).not.toThrow()
  })

  // -------------------------------------------------------------------------
  // 4. Reconnect on close — listeners survive, post-reconnect frame arrives
  // -------------------------------------------------------------------------
  it('reconnects after close and delivers post-reconnect frames to existing subscribers', async () => {
    const client = new WsClient()
    const cb = vi.fn()

    client.subscribe('domain-event', cb)
    await Promise.resolve()

    const ws1 = FakeWS.instances[0]
    expect(ws1).toBeDefined()

    // Confirm first frame works
    ws1.emit(JSON.stringify({ channel: 'domain-event', payload: { type: 'before' } }))
    expect(cb).toHaveBeenCalledTimes(1)

    // Trigger disconnect
    ws1.triggerClose()

    // Advance timers to trigger the reconnect
    vi.advanceTimersByTime(2000)

    // Allow the new socket's onopen Promise to settle
    await Promise.resolve()

    const ws2 = FakeWS.instances[1]
    expect(ws2).toBeDefined()
    expect(ws2).not.toBe(ws1)

    // Original subscriber still receives frames on the new socket
    ws2.emit(JSON.stringify({ channel: 'domain-event', payload: { type: 'after' } }))
    expect(cb).toHaveBeenCalledTimes(2)
    expect(cb).toHaveBeenLastCalledWith({ type: 'after' })
  })

  // -------------------------------------------------------------------------
  // 5. Malformed JSON frame — does not throw
  // -------------------------------------------------------------------------
  it('does not throw on malformed JSON frames', async () => {
    const client = new WsClient()
    client.subscribe('transcription:progress', vi.fn())

    await Promise.resolve()

    const ws = FakeWS.instances[0]
    expect(() => ws.emit('not-valid-json{')).not.toThrow()
    expect(() => ws.emit('')).not.toThrow()
  })
})
