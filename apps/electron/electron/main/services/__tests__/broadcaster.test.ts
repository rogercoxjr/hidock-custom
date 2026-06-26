import { describe, it, expect, afterEach } from 'vitest'
import { getBroadcaster, setBroadcaster } from '../broadcaster'

describe('broadcaster registry', () => {
  afterEach(() => setBroadcaster(null))

  it('returns a no-op broadcaster when none is set (no throw)', () => {
    expect(() => getBroadcaster().broadcast('x', { a: 1 })).not.toThrow()
  })

  it('routes broadcast() to the active broadcaster', () => {
    const calls: Array<{ channel: string; payload: unknown }> = []
    setBroadcaster({ broadcast: (channel, payload) => calls.push({ channel, payload }) })
    getBroadcaster().broadcast('transcription:progress', { recordingId: 'r1', percent: 42 })
    expect(calls).toEqual([{ channel: 'transcription:progress', payload: { recordingId: 'r1', percent: 42 } }])
  })

  it('setBroadcaster(null) reverts to the no-op', () => {
    setBroadcaster({ broadcast: () => { throw new Error('should not be called') } })
    setBroadcaster(null)
    expect(() => getBroadcaster().broadcast('x', 1)).not.toThrow()
  })
})
