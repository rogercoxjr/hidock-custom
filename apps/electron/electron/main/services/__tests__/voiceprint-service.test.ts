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
 * D4-T4 addition: `decodeRecordingPcm16k` uses an ESM `import { execFile }`
 * wrapped in `promisify(execFile)` — the SAME primitive as the sibling ffmpeg
 * service (audio-normalize.ts). `vi.mock('child_process')` DOES intercept it
 * (unlike the CJS require above). The mock mirrors audio-normalize's callback
 * `execFile`, and additionally attaches `util.promisify.custom` so
 * `promisify(execFile)` resolves `{ stdout, stderr }` and rejects with an Error
 * carrying the captured `.stderr` — exactly like Node's real execFile. The
 * factory captures args via the hoisted `shared` object so each test can assert
 * the exact ffmpeg invocation without spawning a real process.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Module from 'module'
import { collectCleanSpeechMs, MIN_CLEAN_SPEECH_MS, decodeRecordingPcm16k } from '../voiceprint-service'
import type { Turn } from '../asr/asr-provider'

// ---------------------------------------------------------------------------
// Shared state for child_process mock (vi.hoisted so the factory can close
// over it before any imports are resolved).
// ---------------------------------------------------------------------------
const shared = vi.hoisted(() => ({
  execFileReject: null as null | { message: string; stderr: string },
  pcmStdout: Buffer.alloc(0) as Buffer,
  capturedArgs: [] as string[],
}))

vi.mock('child_process', () => {
  // Callback-style execFile, mirroring audio-normalize.test.ts.
  const execFile = vi.fn((...args: unknown[]) => {
    const callback = args[args.length - 1] as (e: Error | null, stdout: Buffer, stderr: string) => void
    shared.capturedArgs = args[1] as string[]
    if (shared.execFileReject) {
      const err = Object.assign(new Error(shared.execFileReject!.message), {
        stderr: shared.execFileReject!.stderr,
      })
      callback(err, Buffer.alloc(0), shared.execFileReject!.stderr)
    } else {
      callback(null, shared.pcmStdout, '')
    }
    return { pid: 1 }
  })
  // Mirror Node's execFile[util.promisify.custom]: resolve { stdout, stderr } on
  // success, reject with an Error carrying .stderr on failure. This lets the
  // service keep promisify(execFile) (consistent with audio-normalize) while the
  // test still drives both paths.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { promisify } = require('util') as typeof import('util')
  ;(execFile as unknown as Record<symbol, unknown>)[promisify.custom] = (...args: unknown[]) => {
    shared.capturedArgs = args[1] as string[]
    if (shared.execFileReject) {
      const err = Object.assign(new Error(shared.execFileReject!.message), {
        stderr: shared.execFileReject!.stderr,
      })
      return Promise.reject(err)
    }
    return Promise.resolve({ stdout: shared.pcmStdout, stderr: '' })
  }
  return { execFile }
})

vi.mock('../asr/audio-normalize', () => ({
  resolveFfmpegPath: vi.fn(() => '/fake/ffmpeg'),
}))

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

describe('decodeRecordingPcm16k() — whole-file PCM decode (§6.7 step 3)', () => {
  beforeEach(() => {
    shared.execFileReject = null
    shared.pcmStdout = Buffer.from([0, 1, 0, 2]) // 2 s16le samples (4 bytes)
    shared.capturedArgs = []
  })

  it('6. decodes 16 kHz mono pcm_s16le to stdout (pipe:1), NOT mp3', async () => {
    const buf = await decodeRecordingPcm16k('/recordings/m.hda')
    expect(shared.capturedArgs).toContain('-ar')
    expect(shared.capturedArgs).toContain('16000')
    expect(shared.capturedArgs).toContain('-ac')
    expect(shared.capturedArgs).toContain('1')
    expect(shared.capturedArgs).toContain('-f')
    expect(shared.capturedArgs).toContain('pcm_s16le')
    expect(shared.capturedArgs).toContain('pipe:1')
    expect(shared.capturedArgs).not.toContain('-b:a') // never the MP3 bitrate flag
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(buf.length).toBe(4)
  })

  it('7. ffmpeg decode failure throws (caller skips enrollment, keeps mapping)', async () => {
    shared.execFileReject = { message: 'exit 1', stderr: 'bad input' }
    await expect(decodeRecordingPcm16k('/recordings/bad.hda')).rejects.toThrow(/pcm decode failed/i)
  })

  it('8. maxBuffer overflow (long recording) rejects with handled msg + preserves stderr', async () => {
    // ~2.3 h of 16 kHz mono s16le (~32000 B/s) overflows the 256 MB cap; execFile
    // rejects with a maxBuffer error. The message must be handled (not a crash)
    // and surface the captured stderr so callers/diagnostics see the cause.
    shared.execFileReject = { message: 'stdout maxBuffer exceeded', stderr: 'bad input' }
    await expect(decodeRecordingPcm16k('/recordings/huge.hda')).rejects.toThrow(/pcm decode failed/i)
    await expect(decodeRecordingPcm16k('/recordings/huge.hda')).rejects.toThrow(/bad input/)
  })
})
