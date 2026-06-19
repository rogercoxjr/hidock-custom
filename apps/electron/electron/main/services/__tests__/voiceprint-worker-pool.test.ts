import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

let lastChild: any = null
let behavior: 'reply' | 'ok-false' | 'silent' = 'reply'
function makeChild() {
  const c = new EventEmitter() as any
  c.kill = vi.fn()
  c.postMessage = (msg: any) => {
    if (behavior === 'reply') {
      setImmediate(() => c.emit('message', { id: msg.id, ok: true, dim: 256, embedding: new Float32Array(256).fill(0.1) }))
    } else if (behavior === 'ok-false') {
      setImmediate(() => c.emit('message', { id: msg.id, ok: false, error: 'x' }))
    }
    // 'silent': never replies
  }
  lastChild = c
  return c
}
vi.mock('electron', () => ({
  utilityProcess: { fork: vi.fn(() => makeChild()) },
  app: { isPackaged: false, getAppPath: () => '/fake/app' },
}))

import { embedSamples, shutdownVoiceprintPool } from '../voiceprint-worker-pool'

beforeEach(() => { behavior = 'reply'; shutdownVoiceprintPool() })
afterEach(() => { shutdownVoiceprintPool(); vi.useRealTimers() })

describe('voiceprint worker pool', () => {
  it('forks a child and resolves an embedding', async () => {
    const emb = await embedSamples('/fake/app/model.onnx', 16000, new Float32Array(16000))
    expect(emb).toBeInstanceOf(Float32Array)
    expect(emb!.length).toBe(256)
  })
  it('resolves null when the worker replies ok:false', async () => {
    behavior = 'ok-false'
    expect(await embedSamples('/m', 16000, new Float32Array(10))).toBeNull()
  })
  it('resolves null on timeout when the worker never replies', async () => {
    vi.useFakeTimers()
    behavior = 'silent'
    const p = embedSamples('/m', 16000, new Float32Array(10))
    await vi.advanceTimersByTimeAsync(31_000)
    expect(await p).toBeNull()
  })
  it('shutdown resolves pending requests to null', async () => {
    behavior = 'silent'
    const p = embedSamples('/m', 16000, new Float32Array(10))
    shutdownVoiceprintPool()
    expect(await p).toBeNull()
  })
  it('child exit resolves pending to null and respawns on next call', async () => {
    behavior = 'silent'
    const p = embedSamples('/m', 16000, new Float32Array(10))
    lastChild.emit('exit', 0)
    expect(await p).toBeNull()
    behavior = 'reply'
    const emb = await embedSamples('/m', 16000, new Float32Array(10))
    expect(emb).toBeInstanceOf(Float32Array)
  })
})
