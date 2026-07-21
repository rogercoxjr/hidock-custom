import { describe, it, expect, afterAll } from 'vitest'
import { existsSync } from 'fs'
import { join } from 'path'

/**
 * Proves the hosted-hub (plain Node) embedding path works: voiceprint-worker-pool must run the
 * sherpa embedding via worker_threads (NOT Electron utilityProcess) and return a 256-dim vector.
 * Before the fix this resolved null (utilityProcess unavailable → hosted no-op), so voiceprints
 * were never enrolled on the Docker deployment.
 *
 * Skips gracefully when the addon or model isn't present (e.g. CI without models:fetch), so it
 * never fails the suite for an environmental reason — it only asserts when the pieces exist.
 */
const MODEL_ID = '3dspeaker_eres2net_en_voxceleb'
const modelFile = join(process.cwd(), 'resources', 'models', `${MODEL_ID}.onnx`)

let addonPresent = false
try { require('sherpa-onnx-node'); addonPresent = true } catch { addonPresent = false }

const ready = addonPresent && existsSync(modelFile)
const maybe = ready ? describe : describe.skip

maybe('voiceprint worker pool (worker_threads / plain Node)', () => {
  afterAll(async () => {
    const { shutdownVoiceprintPool } = await import('../voiceprint-worker-pool')
    shutdownVoiceprintPool()
  })

  it('embeds 16kHz mono PCM to a 192-dim vector under plain Node', async () => {
    const { embedSamples } = await import('../voiceprint-worker-pool')

    // ~11 s of 16kHz mono audio: a low tone + light noise (real signal so the extractor is ready).
    const sr = 16000
    const n = sr * 11
    const samples = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      samples[i] = 0.25 * Math.sin((2 * Math.PI * 140 * i) / sr) + (((i * 2654435761) % 1000) / 1000 - 0.5) * 0.02
    }

    const emb = await embedSamples(modelFile, sr, samples)
    expect(emb).toBeInstanceOf(Float32Array)
    // ERes2Net (3dspeaker eres2net en_voxceleb) emits 192-dim embeddings. The pipeline stores the
    // actual dim per-voiceprint, so this documents the real model output rather than an assumption.
    expect(emb!.length).toBe(192)
    // A real embedding is not all-zero.
    expect(emb!.some((v) => v !== 0)).toBe(true)
  }, 40_000)

  it('resolves null for an empty model path without starting a backend', async () => {
    const { embedSamples } = await import('../voiceprint-worker-pool')
    const emb = await embedSamples('', 16000, new Float32Array(16000))
    expect(emb).toBeNull()
  })
})
