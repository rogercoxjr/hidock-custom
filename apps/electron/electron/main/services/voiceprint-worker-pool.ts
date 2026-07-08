import { join } from 'path'

// 'electron' is intentionally NOT imported at module scope. This module is reachable from the
// hosted Fastify server's import graph (speakers route -> voiceprint-service -> here), where the
// process is plain Node: a static top-level electron import throws at MODULE LOAD (a missing
// named export on the CJS shim, or "Cannot find module" when absent) and takes the route/boot
// down. Instead we load electron LAZILY via dynamic import (which vi.mock intercepts and the
// Electron runtime resolves) ONLY when actually running under Electron; anything else degrades
// voiceprint embedding to a graceful no-op. (Phase 2 replaces utilityProcess with worker_threads
// to drop the electron dependency here entirely.)

// A worker reply can be lost if the child stalls inside sherpa or dies without an 'exit'
// event; without a deadline embedSamples would hang forever and stall the caller's loop.
const EMBED_TIMEOUT_MS = 30_000

type Pending = { resolve: (v: Float32Array | null) => void; timer: ReturnType<typeof setTimeout> }
let child: Electron.UtilityProcess | null = null
// Memoises the in-flight fork so concurrent first-callers share one child (the electron load is
// async now, so two calls could otherwise race and fork twice). Reset on exit/shutdown/failure.
let childPromise: Promise<Electron.UtilityProcess | null> | null = null
const pending = new Map<string, Pending>()
let seq = 0

/**
 * Load the electron API, or null when not running under Electron.
 *
 * In a plain-Node process `import('electron')` resolves to the package's path STRING (no API)
 * rather than throwing, and when the package is absent it rejects. Either way `utilityProcess`
 * is missing, so we treat the absence of that API as "not in Electron" and degrade to a no-op.
 */
async function loadElectron(): Promise<typeof import('electron') | null> {
  try {
    const electron = await import('electron')
    const hasApi = !!electron && typeof (electron as { utilityProcess?: unknown }).utilityProcess === 'object'
    return hasApi ? electron : null
  } catch {
    return null
  }
}

function workerPath(app: Electron.App): string {
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

// Resolve to the running utilityProcess child, forking it on first use. Resolves null under plain
// Node (hosted) where utilityProcess is unavailable — callers then no-op instead of crashing.
function ensureChild(): Promise<Electron.UtilityProcess | null> {
  if (child) return Promise.resolve(child)
  if (childPromise) return childPromise
  childPromise = (async () => {
    const electron = await loadElectron()
    if (!electron) {
      childPromise = null // allow a later retry (e.g. once running under Electron)
      return null
    }
    const { utilityProcess, app } = electron
    const c = utilityProcess.fork(workerPath(app))
    c.on('message', (m: { id: string; ok: boolean; embedding?: Float32Array }) => {
      settle(m.id, m.ok && m.embedding ? new Float32Array(m.embedding) : null)
    })
    c.on('exit', () => {
      for (const id of [...pending.keys()]) settle(id, null)
      child = null // next call re-spawns
      childPromise = null
    })
    child = c
    return c
  })()
  return childPromise
}

/**
 * Embed samples off the main thread. Resolves null on any failure or timeout (never throws).
 * Under plain Node (hosted mode) the utilityProcess worker pool is unavailable, so this resolves
 * null after a debug log — voiceprint capture degrades to a no-op instead of crashing.
 */
export function embedSamples(modelPath: string, sampleRate: number, samples: Float32Array): Promise<Float32Array | null> {
  return new Promise((resolve) => {
    const id = `vp_${++seq}`
    const timer = setTimeout(() => settle(id, null), EMBED_TIMEOUT_MS)
    pending.set(id, { resolve, timer })
    ensureChild()
      .then((c) => {
        if (!c) {
          console.debug('[Voiceprint] utilityProcess unavailable under plain Node — skipping embedding (hosted no-op)')
          settle(id, null)
          return
        }
        c.postMessage({ id, modelPath, sampleRate, samples })
      })
      .catch(() => settle(id, null))
  })
}

export function shutdownVoiceprintPool(): void {
  if (child) { try { child.kill() } catch { /* ignore */ } }
  child = null
  childPromise = null
  for (const id of [...pending.keys()]) settle(id, null)
}
