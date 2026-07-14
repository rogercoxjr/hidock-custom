/**
 * dataFreshness.test.ts — the coalesced invalidation bus.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { subscribeFreshness, emitFreshness } from '../dataFreshness'

describe('dataFreshness bus', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('notifies subscribers after the debounce window', () => {
    const cb = vi.fn()
    subscribeFreshness('recordings', cb)

    emitFreshness('recordings')
    expect(cb).not.toHaveBeenCalled() // trailing edge — nothing yet

    vi.advanceTimersByTime(300)
    expect(cb).toHaveBeenCalledOnce()
  })

  it('coalesces a burst of emits into a single notification', () => {
    const cb = vi.fn()
    subscribeFreshness('recordings', cb)

    // Simulate 20 downloads finishing near-instantly.
    for (let i = 0; i < 20; i++) emitFreshness('recordings')

    vi.advanceTimersByTime(300)
    expect(cb).toHaveBeenCalledOnce()
  })

  it('keeps topics independent', () => {
    const recCb = vi.fn()
    const actCb = vi.fn()
    subscribeFreshness('recordings', recCb)
    subscribeFreshness('actionables', actCb)

    emitFreshness('recordings')
    vi.advanceTimersByTime(300)

    expect(recCb).toHaveBeenCalledOnce()
    expect(actCb).not.toHaveBeenCalled()
  })

  it('stops notifying after unsubscribe', () => {
    const cb = vi.fn()
    const unsub = subscribeFreshness('projects', cb)

    unsub()
    emitFreshness('projects')
    vi.advanceTimersByTime(300)

    expect(cb).not.toHaveBeenCalled()
  })
})
