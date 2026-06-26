import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getEventBus } from '../event-bus'
import { setBroadcaster } from '../broadcaster'

describe('event-bus broadcasts via the broadcaster', () => {
  const calls: Array<{ channel: string; payload: any }> = []
  beforeEach(() => { calls.length = 0; setBroadcaster({ broadcast: (channel, payload) => calls.push({ channel, payload: payload as any }) }) })
  afterEach(() => setBroadcaster(null))

  it('emitDomainEvent sends a sanitized domain-event over the broadcaster', () => {
    getEventBus().emitDomainEvent({
      type: 'storage:tier-assigned', timestamp: '',
      payload: { recordingId: 'r1', tier: 'cold', reason: 'C:\\\\Users\\\\me\\\\secret.wav too old' }
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].channel).toBe('domain-event')
    expect(calls[0].payload.type).toBe('storage:tier-assigned')
    // sanitize still applied: absolute path scrubbed to [path]
    expect(calls[0].payload.payload.reason).toContain('[path]')
    expect(calls[0].payload.payload.reason).not.toContain('secret.wav')
  })

  it('emitDomainEvent still notifies in-process listeners', () => {
    let seen = 0
    const off = getEventBus().onDomainEvent('quality:assessed', () => { seen++ })
    getEventBus().emitDomainEvent({ type: 'quality:assessed', timestamp: '', payload: { recordingId: 'r1', quality: 'high', assessmentMethod: 'auto', confidence: 1 } })
    off()
    expect(seen).toBe(1)
  })
})
