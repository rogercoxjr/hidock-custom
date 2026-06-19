import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

const fakeChild = new EventEmitter() as any
fakeChild.postMessage = (msg: any) => {
  // echo back a fake embedding on the next tick, keyed by id. Electron's parent-side
  // UtilityProcess.on('message') delivers the payload UNWRAPPED (the `.data` envelope
  // only exists child-side on process.parentPort), so the pool reads m.id directly.
  setImmediate(() => fakeChild.emit('message', { id: msg.id, ok: true, dim: 256, embedding: new Float32Array(256).fill(0.1) }))
}
vi.mock('electron', () => ({
  utilityProcess: { fork: vi.fn(() => fakeChild) },
  app: { isPackaged: false, getAppPath: () => '/fake/app' }
}))

import { embedSamples, shutdownVoiceprintPool } from '../voiceprint-worker-pool'

beforeEach(() => { shutdownVoiceprintPool() })

describe('voiceprint worker pool', () => {
  it('forks a child and resolves an embedding', async () => {
    const emb = await embedSamples('/fake/app/model.onnx', 16000, new Float32Array(16000))
    expect(emb).toBeInstanceOf(Float32Array)
    expect(emb!.length).toBe(256)
  })
})
