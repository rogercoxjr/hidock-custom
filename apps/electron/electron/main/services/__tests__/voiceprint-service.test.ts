/**
 * voiceprint-service tests — speaker-diarization D4 (spec §6.7, AC4).
 *
 * Capture-only hook. The sherpa-onnx-node native addon load is exercised on
 * BOTH paths (AC4): load-success and load-failure. No real addon, no ffmpeg,
 * no device.
 *
 * NOTE ON THE MOCK STRATEGY: the service loads the addon with a synchronous
 * CommonJS `require('sherpa-onnx-node')` in a try/catch — this is mandatory
 * because the Electron main process bundles to CJS, where top-level `await
 * import(...)` is invalid. Vitest v4's `vi.mock` only patches ESM `import`s, NOT
 * `require()` (verified: a hoisted vi.mock factory is invisible to the service's
 * require). So to drive the SUCCESS path we override Node's `Module._load` to
 * stub `sherpa-onnx-node`, which the service's real `require()` honours — this
 * exercises the exact production code path. The FAILURE path needs no mock at
 * all: the addon genuinely is not installed yet (it arrives in D4-T7), so a
 * fresh import of the service hits a real "Cannot find module" and degrades.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest'
import Module from 'module'
import { collectCleanSpeechMs, MIN_CLEAN_SPEECH_MS } from '../voiceprint-service'
import type { Turn } from '../asr/asr-provider'

type LoadFn = (request: string, ...rest: unknown[]) => unknown
const moduleInternals = Module as unknown as { _load: LoadFn }

describe('voiceprint-service load (§6.7, AC4)', () => {
  it('1. isVoiceprintAvailable() is true when sherpa-onnx-node loads', async () => {
    // Stub the native addon at the CJS resolver so the service's require()
    // succeeds, then load a fresh copy of the module so its module-level
    // require runs under the stub.
    const realLoad = moduleInternals._load
    moduleInternals._load = function (request: string, ...rest: unknown[]): unknown {
      if (request === 'sherpa-onnx-node') {
        class SpeakerEmbeddingExtractor {
          dim = 256
          createStream() {
            return {}
          }
          acceptWaveform() {}
          isReady() {
            return true
          }
          compute() {
            return new Float32Array(this.dim)
          }
        }
        return { SpeakerEmbeddingExtractor }
      }
      return realLoad.apply(this, [request, ...rest])
    }
    try {
      vi.resetModules()
      const { isVoiceprintAvailable } = await import('../voiceprint-service')
      expect(isVoiceprintAvailable()).toBe(true)
    } finally {
      moduleInternals._load = realLoad
      vi.resetModules()
    }
  })

  it('2. isVoiceprintAvailable() is false when sherpa-onnx-node is missing', async () => {
    // No stub: the addon is genuinely absent (installed in D4-T7). A fresh
    // import makes the service's require() throw, which it must swallow.
    vi.resetModules()
    const { isVoiceprintAvailable } = await import('../voiceprint-service')
    expect(isVoiceprintAvailable()).toBe(false)
  })
})

describe('collectCleanSpeechMs() — ≥10 s clean-speech gate (§6.7)', () => {
  it('3. sums non-overlapped turns for the target label', () => {
    const turns: Turn[] = [
      { speaker: 'A', startMs: 0, endMs: 4000, text: 'one' },
      { speaker: 'B', startMs: 4000, endMs: 6000, text: 'two' },
      { speaker: 'A', startMs: 6000, endMs: 13000, text: 'three' }
    ]
    // A: 4000 + 7000 = 11000 ms clean (no overlap with B)
    expect(collectCleanSpeechMs(turns, 'A')).toBe(11000)
  })

  it('4. excludes the portion of a label turn that overlaps another label', () => {
    const turns: Turn[] = [
      { speaker: 'A', startMs: 0, endMs: 10000, text: 'a' },
      { speaker: 'B', startMs: 5000, endMs: 7000, text: 'b' } // overlaps A in [5000,7000]
    ]
    // A keeps [0,5000] + [7000,10000] = 5000 + 3000 = 8000 ms clean.
    expect(collectCleanSpeechMs(turns, 'A')).toBe(8000)
  })

  it('5. MIN_CLEAN_SPEECH_MS is 10 s', () => {
    expect(MIN_CLEAN_SPEECH_MS).toBe(10_000)
  })
})
