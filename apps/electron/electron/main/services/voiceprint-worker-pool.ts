import { utilityProcess, app } from 'electron'
import { join } from 'path'

type Pending = { resolve: (v: Float32Array | null) => void }
let child: ReturnType<typeof utilityProcess.fork> | null = null
const pending = new Map<string, Pending>()
let seq = 0

function workerPath(): string {
  // electron-vite emits the worker next to the main bundle (out/main/voiceprint-worker.js).
  return join(app.getAppPath(), 'out', 'main', 'voiceprint-worker.js')
}

function ensureChild() {
  if (child) return child
  child = utilityProcess.fork(workerPath())
  child.on('message', (m: { id: string; ok: boolean; embedding?: Float32Array }) => {
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    p.resolve(m.ok && m.embedding ? new Float32Array(m.embedding) : null)
  })
  child.on('exit', () => {
    for (const p of pending.values()) p.resolve(null)
    pending.clear()
    child = null // next call re-spawns
  })
  return child
}

/** Embed samples off the main thread. Resolves null on any failure (never throws). */
export function embedSamples(modelPath: string, sampleRate: number, samples: Float32Array): Promise<Float32Array | null> {
  return new Promise((resolve) => {
    try {
      const c = ensureChild()
      const id = `vp_${++seq}`
      pending.set(id, { resolve })
      // Electron's UtilityProcess.postMessage transfer list is MessagePortMain[], not
      // ArrayBuffer[] — it can't transfer the samples buffer the way Worker.postMessage
      // does, so the message is structured-cloned (a copy). Bounded (≤60 s of 16 kHz
      // mono ≈ 3.8 MB) so the clone cost is negligible.
      c.postMessage({ id, modelPath, sampleRate, samples })
    } catch {
      resolve(null)
    }
  })
}

export function shutdownVoiceprintPool(): void {
  if (child) { try { child.kill() } catch { /* ignore */ } child = null }
  for (const p of pending.values()) p.resolve(null)
  pending.clear()
}
