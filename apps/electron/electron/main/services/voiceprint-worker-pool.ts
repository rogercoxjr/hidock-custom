import { join } from 'path'
import { Worker as NodeWorker } from 'node:worker_threads'

// 'electron' is intentionally NOT imported at module scope. This module is reachable from the
// hosted Fastify server's import graph (speakers route -> voiceprint-service -> here), where the
// process is plain Node: a static top-level electron import throws at MODULE LOAD (a missing
// named export on the CJS shim, or "Cannot find module" when absent) and takes the route/boot
// down. Instead we load electron LAZILY via dynamic import (which vi.mock intercepts and the
// Electron runtime resolves) ONLY when actually running under Electron.
//
// Two embedding backends share one message/pending protocol:
//   • Electron  → utilityProcess child (out/main/voiceprint-worker.js). Keeps the desktop app's
//                 UI thread free.
//   • plain Node (hosted hub) → worker_threads Worker running an inline CommonJS script that
//                 require()s sherpa-onnx-node. Keeps the Fastify event loop free. This is what
//                 makes voiceprint enrollment work on the Docker/Unraid deployment.
// If neither backend can start (no addon, no worker support) embedSamples resolves null — capture
// degrades to a graceful no-op instead of crashing.

// A worker reply can be lost if the child stalls inside sherpa or dies without an 'exit'
// event; without a deadline embedSamples would hang forever and stall the caller's loop.
const EMBED_TIMEOUT_MS = 30_000

type EmbedRequest = { id: string; modelPath: string; sampleRate: number; samples: Float32Array }
type EmbedReply = { id: string; ok: boolean; embedding?: Float32Array; error?: string }
type Pending = { resolve: (v: Float32Array | null) => void; timer: ReturnType<typeof setTimeout> }

// A backend normalises the two child kinds (utilityProcess / worker_threads) to post + kill.
type Backend = { post: (m: EmbedRequest) => void; kill: () => void }

let backend: Backend | null = null
// Memoises the in-flight start so concurrent first-callers share one child (backend start is
// async under Electron). Reset on exit/shutdown/failure so a later call can retry.
let backendPromise: Promise<Backend | null> | null = null
const pending = new Map<string, Pending>()
let seq = 0

/**
 * Inline worker_threads script (CommonJS, run with { eval: true }). Mirrors
 * workers/voiceprint-worker.ts but talks over worker_threads' parentPort instead of
 * utilityProcess' process.parentPort. Kept inline so no extra build entry / on-disk worker
 * file is needed in the esbuild server bundle — sherpa-onnx-node stays a runtime require
 * (resolved from node_modules), matching how it is marked external in build-server.mjs.
 */
const NODE_WORKER_SRC = `
const { parentPort } = require('worker_threads')
let sherpa = null
const extractors = new Map()
function getExtractor(modelPath) {
  if (!sherpa) sherpa = require('sherpa-onnx-node')
  let ext = extractors.get(modelPath)
  if (!ext) {
    ext = new sherpa.SpeakerEmbeddingExtractor({ model: modelPath, numThreads: 1, debug: false })
    extractors.set(modelPath, ext)
  }
  return ext
}
parentPort.on('message', (msg) => {
  const { id, modelPath, sampleRate, samples } = msg
  try {
    const ext = getExtractor(modelPath)
    const stream = ext.createStream()
    stream.acceptWaveform({ sampleRate, samples })
    stream.inputFinished()
    if (!ext.isReady(stream)) {
      parentPort.postMessage({ id, ok: false, error: 'extractor not ready' })
      return
    }
    const emb = new Float32Array(ext.compute(stream, false)) // V8-owned copy
    parentPort.postMessage({ id, ok: true, dim: ext.dim, embedding: emb })
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err && err.message ? err.message : String(err) })
  }
})
`

/**
 * Load the electron API, or null when not running under Electron.
 *
 * In a plain-Node process `import('electron')` resolves to the package's path STRING (no API)
 * rather than throwing, and when the package is absent it rejects. Either way `utilityProcess`
 * is missing, so we treat the absence of that API as "not in Electron".
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

function onReply(m: EmbedReply): void {
  settle(m.id, m.ok && m.embedding ? new Float32Array(m.embedding) : null)
}

// A backend died/exited — fail everything in flight and allow a fresh start on the next call.
function onBackendGone(): void {
  for (const id of [...pending.keys()]) settle(id, null)
  backend = null
  backendPromise = null
}

// Electron utilityProcess backend (desktop app). Returns null under plain Node.
async function startElectronBackend(): Promise<Backend | null> {
  const electron = await loadElectron()
  if (!electron) return null
  const { utilityProcess, app } = electron
  const c = utilityProcess.fork(workerPath(app))
  c.on('message', onReply)
  c.on('exit', onBackendGone)
  return { post: (m) => c.postMessage(m), kill: () => { try { c.kill() } catch { /* ignore */ } } }
}

// worker_threads backend (hosted hub / plain Node). Synchronous start; returns null if the
// worker_threads Worker can't be constructed.
function startNodeBackend(): Backend | null {
  try {
    const w = new NodeWorker(NODE_WORKER_SRC, { eval: true })
    w.on('message', onReply)
    w.on('error', (err) => {
      console.warn(`[Voiceprint] worker_threads embedder error: ${err.message}`)
      onBackendGone()
    })
    w.on('exit', onBackendGone)
    // Do not keep the process alive on the worker's account (the server holds it open itself).
    w.unref()
    return { post: (m) => w.postMessage(m), kill: () => { try { void w.terminate() } catch { /* ignore */ } } }
  } catch (e) {
    console.warn(`[Voiceprint] worker_threads backend unavailable: ${(e as Error).message}`)
    return null
  }
}

// Resolve the running backend, starting it on first use. Prefers the Electron utilityProcess
// (desktop) and falls back to worker_threads (hosted). Resolves null when neither can start.
function ensureBackend(): Promise<Backend | null> {
  if (backend) return Promise.resolve(backend)
  if (backendPromise) return backendPromise
  backendPromise = (async () => {
    const b = (await startElectronBackend()) ?? startNodeBackend()
    if (!b) {
      backendPromise = null // allow a later retry
      return null
    }
    backend = b
    return b
  })()
  return backendPromise
}

/**
 * Embed samples off the main thread. Resolves null on any failure or timeout (never throws).
 * An empty modelPath (no model provisioned) resolves null without starting a backend.
 */
export function embedSamples(modelPath: string, sampleRate: number, samples: Float32Array): Promise<Float32Array | null> {
  return new Promise((resolve) => {
    if (!modelPath) {
      console.debug('[Voiceprint] no model path resolved — skipping embedding')
      resolve(null)
      return
    }
    const id = `vp_${++seq}`
    const timer = setTimeout(() => settle(id, null), EMBED_TIMEOUT_MS)
    pending.set(id, { resolve, timer })
    ensureBackend()
      .then((b) => {
        if (!b) {
          console.debug('[Voiceprint] no embedding backend available — skipping embedding')
          settle(id, null)
          return
        }
        b.post({ id, modelPath, sampleRate, samples })
      })
      .catch(() => settle(id, null))
  })
}

export function shutdownVoiceprintPool(): void {
  if (backend) backend.kill()
  backend = null
  backendPromise = null
  for (const id of [...pending.keys()]) settle(id, null)
}
