import { utilityProcess, app } from 'electron'
import { join } from 'path'

// A worker reply can be lost if the child stalls inside sherpa or dies without an 'exit'
// event; without a deadline embedSamples would hang forever and stall the caller's loop.
const EMBED_TIMEOUT_MS = 30_000

type Pending = { resolve: (v: Float32Array | null) => void; timer: ReturnType<typeof setTimeout> }
let child: ReturnType<typeof utilityProcess.fork> | null = null
const pending = new Map<string, Pending>()
let seq = 0

function workerPath(): string {
  // electron-vite emits the worker next to the main bundle (out/main/voiceprint-worker.js).
  return join(app.getAppPath(), 'out', 'main', 'voiceprint-worker.js')
}

function settle(id: string, value: Float32Array | null): void {
  const p = pending.get(id)
  if (!p) return
  clearTimeout(p.timer)
  pending.delete(id)
  p.resolve(value)
}

function ensureChild() {
  if (child) return child
  child = utilityProcess.fork(workerPath())
  child.on('message', (m: { id: string; ok: boolean; embedding?: Float32Array }) => {
    settle(m.id, m.ok && m.embedding ? new Float32Array(m.embedding) : null)
  })
  child.on('exit', () => {
    for (const id of [...pending.keys()]) settle(id, null)
    child = null // next call re-spawns
  })
  return child
}

/** Embed samples off the main thread. Resolves null on any failure or timeout (never throws). */
export function embedSamples(modelPath: string, sampleRate: number, samples: Float32Array): Promise<Float32Array | null> {
  return new Promise((resolve) => {
    const id = `vp_${++seq}`
    const timer = setTimeout(() => settle(id, null), EMBED_TIMEOUT_MS)
    pending.set(id, { resolve, timer })
    try {
      ensureChild().postMessage({ id, modelPath, sampleRate, samples })
    } catch {
      settle(id, null)
    }
  })
}

export function shutdownVoiceprintPool(): void {
  if (child) { try { child.kill() } catch { /* ignore */ } child = null }
  for (const id of [...pending.keys()]) settle(id, null)
}
