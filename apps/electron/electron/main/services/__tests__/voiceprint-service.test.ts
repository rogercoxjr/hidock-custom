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
 * D4-T5 addition: `captureVoiceprint` is the full orchestrator. The sherpa
 * extractor is stubbed via `Module._load` (same pattern as test 1). The DB
 * helpers (`getRecordingById`, `getTranscriptByRecordingId`, `insertVoiceprint`)
 * are stubbed via `vi.mock('../database')`. AC4 covers all five outcomes:
 * (a) ≥10s clean → one voiceprints row; (b) <10s → skip; (c) decode failure →
 * skip; (d) sherpa unavailable → skip; (e) file_path null → skip. The
 * `pcmToFloat32` helper is tested directly for slice ranges + s16le→Float32
 * normalisation.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest'
import Module from 'module'
import {
  collectCleanSpeechMs,
  MIN_CLEAN_SPEECH_MS,
  decodeRecordingPcm16k,
  pcmToFloat32,
  sliceLabelWindows,
  VOICEPRINT_MODEL_ID,
} from '../voiceprint-service'
import * as db from '../database'
import type { Turn } from '../asr/asr-provider'

// ---------------------------------------------------------------------------
// Shared state for child_process mock (vi.hoisted so the factory can close
// over it before any imports are resolved).
// D4-T5: also holds sherpa extractor stub state (extractorDim, computeResult).
// ---------------------------------------------------------------------------
const shared = vi.hoisted(() => ({
  execFileReject: null as null | { message: string; stderr: string },
  pcmStdout: Buffer.alloc(0) as Buffer,
  capturedArgs: [] as string[],
  // D4-T5 extractor stub state — mutated by beforeEach
  extractorDim: 256,
  computeResult: new Float32Array(256).fill(0.5),
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

// ---------------------------------------------------------------------------
// D4-T5: DB mock — vi.mock intercepts ESM imports so getRecordingById,
// getTranscriptByRecordingId, and insertVoiceprint are all vi.fn()s.
// ---------------------------------------------------------------------------
vi.mock('../database', () => ({
  getRecordingById: vi.fn(),
  getTranscriptByRecordingId: vi.fn(),
  insertVoiceprint: vi.fn(),
  insertLabelEmbedding: vi.fn(),
  getLabelEmbeddingsForRecording: vi.fn(() => []),
  deleteLabelEmbeddingsForRecording: vi.fn(),
  getActiveVoiceprintsByContactId: vi.fn(() => []),
  getSuggestionsForRecording: vi.fn(() => []),
  getVoiceprintsBySource: vi.fn(() => []),
  getRecordingSpeaker: vi.fn((_recordingId: string, _fileLabel: string) => ({
    recording_id: _recordingId,
    file_label: _fileLabel,
    contact_id: 'c_1',
    source: 'user',
  })),
}))

// ---------------------------------------------------------------------------
// D4 off-thread embedding: captureVoiceprint now routes the sliced samples to
// embedSamples() in a utilityProcess worker (voiceprint-worker-pool), instead of
// computing in-process. Mock the pool so the capture tests drive the embedding
// outcome (a real Float32Array, or null for graceful failure) without spawning a
// child or touching the native addon. The sherpa require stub below still drives
// isVoiceprintAvailable() — the availability probe captureVoiceprint gates on.
// ---------------------------------------------------------------------------
import { embedSamples } from '../voiceprint-worker-pool'
vi.mock('../voiceprint-worker-pool', () => ({
  embedSamples: vi.fn(),
}))

// ---------------------------------------------------------------------------
// D4-T5: electron mock — app is not available outside the real Electron main
// process. Stub it so getExtractor()'s model-path computation doesn't crash.
// The stub SpeakerEmbeddingExtractor (in Module._load) ignores the model path.
// ---------------------------------------------------------------------------
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/fake/app',
    // Task 6: the service now imports ./config, whose DEFAULT_CONFIG calls
    // app.getPath('home') at module load. Provide getPath so that import doesn't crash.
    getPath: (name: string) => (name === 'userData' ? '/fake/userdata' : '/fake/home'),
  },
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
          // Real sherpa API: acceptWaveform + inputFinished live on the STREAM
          // (an OnlineStream), NOT on the extractor.
          createStream() {
            return { acceptWaveform() { /* no-op */ }, inputFinished() { /* no-op */ } }
          }
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

  it('uses the ERes2Net model id (not the retired WeSpeaker)', () => {
    expect(VOICEPRINT_MODEL_ID).toBe('3dspeaker_eres2net_en_voxceleb')
    expect(VOICEPRINT_MODEL_ID).not.toMatch(/wespeaker/i)
  })

  it('2. isVoiceprintAvailable() is false when sherpa-onnx-node is missing', async () => {
    // FORCE the addon to be unresolvable. The package may now be installed
    // (it's an optionalDependency that activation installs), so we can't rely on
    // genuine absence — stub Module._load to throw for it, mirroring a machine
    // where the native addon isn't present. The service's require() must swallow it.
    const realLoad = moduleInternals._load
    moduleInternals._load = function (request: string, ...rest: unknown[]): unknown {
      if (request === 'sherpa-onnx-node') {
        throw new Error("Cannot find module 'sherpa-onnx-node'")
      }
      return realLoad.apply(this, [request, ...rest])
    }
    try {
      vi.resetModules()
      const { isVoiceprintAvailable } = await import('../voiceprint-service')
      expect(isVoiceprintAvailable()).toBe(false)
    } finally {
      moduleInternals._load = realLoad
      vi.resetModules()
    }
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

  it('6. decodes 16 kHz mono s16le to stdout (pipe:1), NOT mp3', async () => {
    const buf = await decodeRecordingPcm16k('/recordings/m.hda')
    expect(shared.capturedArgs).toContain('-ar')
    expect(shared.capturedArgs).toContain('16000')
    expect(shared.capturedArgs).toContain('-ac')
    expect(shared.capturedArgs).toContain('1')
    expect(shared.capturedArgs).toContain('-f')
    // `s16le` is the raw-PCM MUXER. `pcm_s16le` is the CODEC name and is NOT a valid
    // output format — `-f pcm_s16le` errors "Requested output format is not known".
    expect(shared.capturedArgs).toContain('s16le')
    expect(shared.capturedArgs).not.toContain('pcm_s16le')
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

// ---------------------------------------------------------------------------
// D4-T5: pcmToFloat32 — slice / normalise unit tests (AC4-e)
// ---------------------------------------------------------------------------
describe('pcmToFloat32() — s16le slice + normalise (AC4-e)', () => {
  // Build a PCM buffer: 4 samples at 16 kHz mono = 4 * 2 = 8 bytes.
  // Each s16le sample is stored as a pair of bytes (little-endian).
  // Sample values: 0, 16384 (0.5 after /32768), -32768 (-1.0), 32767 (~1.0)
  //   bytes: [0,0], [0,64], [0,128], [255,127]
  const makePcm = () => {
    const buf = Buffer.alloc(8)
    buf.writeInt16LE(0, 0)
    buf.writeInt16LE(16384, 2)
    buf.writeInt16LE(-32768, 4)
    buf.writeInt16LE(32767, 6)
    return buf
  }

  it('8e-1. returns Float32Array with correct s16le→Float32 normalisation', () => {
    // At 16000 samples/s: 1 ms = 16 samples = 32 bytes. Use ms=0..1 for first
    // 2 samples, but since BYTES_PER_MS = 32, a 1ms window gives 32 bytes → 16
    // samples. Our 8-byte PCM has only 4 samples total; use a turn spanning the
    // whole buffer (0..250 ms rounds to 8000 bytes, clamped to pcm.length=8).
    const pcm = makePcm()
    const turns: Turn[] = [{ speaker: 'A', startMs: 0, endMs: 250, text: 'x' }]
    const result = pcmToFloat32(pcm, turns, 'A')
    expect(result).toBeInstanceOf(Float32Array)
    expect(result.length).toBe(4)
    // sample 0: 0 / 32768 = 0
    expect(result[0]).toBeCloseTo(0, 5)
    // sample 1: 16384 / 32768 = 0.5
    expect(result[1]).toBeCloseTo(0.5, 4)
    // sample 2: -32768 / 32768 = -1.0
    expect(result[2]).toBeCloseTo(-1.0, 5)
    // sample 3: 32767 / 32768 ≈ 0.99997
    expect(result[3]).toBeCloseTo(32767 / 32768, 4)
  })

  it('8e-2. skips turns for other labels, only includes the target label', () => {
    const pcm = makePcm()
    const turns: Turn[] = [
      { speaker: 'A', startMs: 0, endMs: 250, text: 'a' },
      { speaker: 'B', startMs: 0, endMs: 250, text: 'b' },
    ]
    // Only 'A' turns included — same 4 samples as above
    const resultA = pcmToFloat32(pcm, turns, 'A')
    const resultB = pcmToFloat32(pcm, turns, 'B')
    expect(resultA.length).toBe(4)
    expect(resultB.length).toBe(4)
    // Both have same bytes, different label filter — both grab the whole buffer
    expect(resultA[1]).toBeCloseTo(0.5, 4)
    expect(resultB[1]).toBeCloseTo(0.5, 4)
  })

  it('8e-3. byte offset calculation: startMs=0 endMs maps to correct byte range', () => {
    // BYTES_PER_MS = 16000 * 2 / 1000 = 32. startMs=0 → byte 0; 1 sample = 2 bytes.
    // A turn covering ms 0..0 (0 bytes) returns empty array.
    const pcm = makePcm()
    const turns: Turn[] = [{ speaker: 'A', startMs: 0, endMs: 0, text: 'x' }]
    expect(pcmToFloat32(pcm, turns, 'A').length).toBe(0)
  })

  it('8e-4. caps output at MAX_EMBED_SPEECH_MS (60 s) of samples regardless of turn length', async () => {
    const { pcmToFloat32: ptf, MAX_EMBED_SPEECH_MS } = await import('../voiceprint-service')
    const capSamples = (MAX_EMBED_SPEECH_MS / 1000) * 16000 // 60 s × 16000 = 960000
    // One 70 s clean turn for label A → 70 s × 32 bytes/ms × 1000 = 2,240,000 bytes.
    const pcm = Buffer.alloc(70_000 * 32)
    const turns: Turn[] = [{ speaker: 'A', startMs: 0, endMs: 70_000, text: 'long' }]
    expect(ptf(pcm, turns, 'A').length).toBe(capSamples)
  })
})

// ---------------------------------------------------------------------------
// D4-T5: captureVoiceprint() — AC4 four outcomes (§6.7)
//
// Sherpa is stubbed via Module._load (same CJS bypass as test 1). The stub
// reads `shared.extractorDim` + `shared.computeResult` so each test can vary
// them. DB helpers are vi.fn()s from the vi.mock('../database') above.
//
// NOTE: test 8d (sherpa unavailable) uses vi.resetModules() + a separate
// dynamic import to get a fresh module instance without the stub.
// ---------------------------------------------------------------------------
describe('captureVoiceprint() — AC4 four outcomes (§6.7)', () => {
  type LoadFn8 = (request: string, ...rest: unknown[]) => unknown
  const mod8 = Module as unknown as { _load: LoadFn8 }
  let realLoad8: LoadFn8

  // 12 s of 16 kHz s16le mono = 12000 * 32 bytes/ms = 384000 bytes
  const TWELVE_SEC_PCM = Buffer.alloc(12000 * 32)

  const longTurns: Turn[] = [
    { speaker: 'A', startMs: 0, endMs: 12000, text: 'plenty' }, // 12 s clean ≥ 10 s
  ]

  beforeAll(() => {
    // Install the sherpa stub for the whole suite (except 8d which resets modules).
    realLoad8 = mod8._load
    mod8._load = function (request: string, ...rest: unknown[]): unknown {
      if (request === 'sherpa-onnx-node') {
        const { extractorDim, computeResult } = shared
        class SpeakerEmbeddingExtractor {
          dim = extractorDim
          // Real sherpa API: the STREAM owns acceptWaveform + inputFinished, and
          // isReady() stays false until inputFinished() — so this stub fails the
          // capture path unless the service uses stream.acceptWaveform() AND
          // stream.inputFinished() (the live bug was ext.acceptWaveform + no finish).
          createStream() {
            return {
              wave: false,
              finished: false,
              acceptWaveform() {
                this.wave = true
              },
              inputFinished() {
                this.finished = true
              },
            }
          }
          isReady(stream: { wave?: boolean; finished?: boolean }) {
            return !!(stream && stream.wave && stream.finished)
          }
          compute(_stream: unknown, enableExternalBuffer?: boolean) {
            // Simulate Electron's V8 Memory Cage: the addon default
            // (enableExternalBuffer=true) allocates an EXTERNAL ArrayBuffer that the
            // cage rejects INSIDE compute(). Only an explicit `false` is allowed.
            if (enableExternalBuffer !== false) {
              throw new Error('External buffers are not allowed')
            }
            return computeResult
          }
        }
        return { SpeakerEmbeddingExtractor }
      }
      return realLoad8.apply(this, [request, ...rest])
    }
    vi.resetModules()
  })

  afterAll(() => {
    mod8._load = realLoad8
    vi.resetModules()
  })

  beforeEach(() => {
    vi.mocked(db.getRecordingById).mockReturnValue({ file_path: '/recordings/m.hda' } as never)
    vi.mocked(db.getTranscriptByRecordingId).mockReturnValue({
      turns: JSON.stringify(longTurns),
    } as never)
    vi.mocked(db.insertVoiceprint).mockReset()
    // Off-thread embedding: the pool resolves a deterministic 256-dim Float32Array by
    // default; individual tests override it (e.g. null for graceful failure).
    vi.mocked(embedSamples).mockReset()
    vi.mocked(embedSamples).mockResolvedValue(new Float32Array(256).fill(0.5))
    shared.execFileReject = null
    shared.pcmStdout = TWELVE_SEC_PCM
    shared.extractorDim = 256
    shared.computeResult = new Float32Array(256).fill(0.5)
  })

  it('8a. ≥10s clean speech → one voiceprints row with model_id + dim (via worker pool)', async () => {
    const { captureVoiceprint: cv } = await import('../voiceprint-service')
    const res = await cv('rec_1', 'A', 'c_1')
    expect(res.captured).toBe(true)
    // The embedding is computed OFF the main thread: captureVoiceprint must hand the
    // sliced clean-speech samples to the worker pool at the resolved model path.
    expect(vi.mocked(embedSamples)).toHaveBeenCalledTimes(1)
    const [calledModelPath, calledSampleRate, calledSamples] = vi.mocked(embedSamples).mock.calls[0]
    expect(calledModelPath).toMatch(/3dspeaker_eres2net_en_voxceleb\.onnx$/)
    expect(calledSampleRate).toBe(16000)
    expect(calledSamples).toBeInstanceOf(Float32Array)
    expect(vi.mocked(db.insertVoiceprint)).toHaveBeenCalledTimes(1)
    const row = vi.mocked(db.insertVoiceprint).mock.calls[0][0]
    expect(row.contact_id).toBe('c_1')
    expect(row.model_id).toBe(VOICEPRINT_MODEL_ID)
    // dim is taken from the worker's returned embedding length.
    expect(row.dim).toBe(256)
    expect(row.embedding).toBeInstanceOf(Uint8Array)
    // Phase 2A provenance fields are persisted for traceability/quality.
    expect(row.source_recording_id).toBe('rec_1')
    expect(row.source_label).toBe('A')
    expect(row.clean_speech_ms).toBe(12000)
    expect(row.quality_score).toBeNull()
    expect(row.model_version).toBe(1)
    expect(row.created_from).toBe('manual')
    expect(res.voiceprintId).toMatch(/^vp_/)
    expect(res.cleanSpeechMs).toBe(12000)
  })

  it('8a-2. worker returns null → mapping kept, NO voiceprint, no throw', async () => {
    // Graceful failure: any worker failure resolves null (never throws), so the
    // speaker→contact mapping always succeeds and no voiceprint row is written.
    vi.mocked(embedSamples).mockResolvedValue(null)
    const { captureVoiceprint: cv } = await import('../voiceprint-service')
    const res = await cv('rec_1', 'A', 'c_1')
    expect(res.captured).toBe(false)
    expect(res.reason).toMatch(/embedding-failed/i)
    expect(vi.mocked(db.insertVoiceprint)).not.toHaveBeenCalled()
  })

  it('8b. <10s clean speech → mapping kept, NO voiceprint, no throw', async () => {
    vi.mocked(db.getTranscriptByRecordingId).mockReturnValue({
      turns: JSON.stringify([{ speaker: 'A', startMs: 0, endMs: 3000, text: 'short' }]),
    } as never)
    const { captureVoiceprint: cv } = await import('../voiceprint-service')
    const res = await cv('rec_1', 'A', 'c_1')
    expect(res.captured).toBe(false)
    expect(res.reason).toBe('insufficient-clean-speech')
    expect(res.cleanSpeechMs).toBe(3000)
    expect(vi.mocked(db.insertVoiceprint)).not.toHaveBeenCalled()
  })

  it('8c. ffmpeg decode failure → mapping kept, NO voiceprint, no throw', async () => {
    shared.execFileReject = { message: 'exit 1', stderr: 'bad' }
    const { captureVoiceprint: cv } = await import('../voiceprint-service')
    const res = await cv('rec_1', 'A', 'c_1')
    expect(res.captured).toBe(false)
    expect(res.reason).toBe('decode-failed')
    expect(res.cleanSpeechMs).toBe(12000)
    expect(vi.mocked(db.insertVoiceprint)).not.toHaveBeenCalled()
  })

  it('8d. sherpa unavailable → no-op, no throw', async () => {
    // FORCE the addon to be unresolvable so isVoiceprintAvailable() is false — the
    // package is now an installed optionalDependency, so genuine absence can't be
    // relied on. Mirror test 2: stub Module._load to throw for it, then load a fresh
    // module so its module-level require() swallows the failure and degrades.
    mod8._load = function (request: string, ...rest: unknown[]): unknown {
      if (request === 'sherpa-onnx-node') {
        throw new Error("Cannot find module 'sherpa-onnx-node'")
      }
      return realLoad8.apply(this, [request, ...rest])
    }
    vi.resetModules()
    try {
      const mod = await import('../voiceprint-service')
      const res = await mod.captureVoiceprint('rec_1', 'A', 'c_1')
      expect(res.captured).toBe(false)
      expect(res.reason).toMatch(/unavailable/i)
    } finally {
      // Restore stub for subsequent tests (8e)
      mod8._load = function (request: string, ...rest: unknown[]): unknown {
        if (request === 'sherpa-onnx-node') {
          const { extractorDim, computeResult } = shared
          class SpeakerEmbeddingExtractor {
            dim = extractorDim
            createStream() {
              return {
                wave: false,
                finished: false,
                acceptWaveform() {
                  this.wave = true
                },
                inputFinished() {
                  this.finished = true
                },
              }
            }
            isReady(stream: { wave?: boolean; finished?: boolean }) {
              return !!(stream && stream.wave && stream.finished)
            }
            compute(_stream: unknown, enableExternalBuffer?: boolean) {
              if (enableExternalBuffer !== false) {
                throw new Error('External buffers are not allowed')
              }
              return computeResult
            }
          }
          return { SpeakerEmbeddingExtractor }
        }
        return realLoad8.apply(this, [request, ...rest])
      }
      vi.resetModules()
    }
  })

  it('8e. audio file not downloaded (file_path null) → no-op, no throw', async () => {
    vi.mocked(db.getRecordingById).mockReturnValue({ file_path: null } as never)
    const { captureVoiceprint: cv } = await import('../voiceprint-service')
    const res = await cv('rec_1', 'A', 'c_1')
    expect(res.captured).toBe(false)
    expect(vi.mocked(db.insertVoiceprint)).not.toHaveBeenCalled()
  })

  // Task 6: privacy gate — when enableVoiceprintCapture is false, captureVoiceprint
  // is a no-op (master gate, spec §14) and never reaches DB/decode, even with sherpa
  // available + ≥10 s clean speech. Mock ../config to flip the toggle off, then load a
  // fresh service so its getConfig() honours the mock.
  it('8f. privacy toggle disabled → capture skipped, NO voiceprint, no throw', async () => {
    vi.resetModules()
    vi.mocked(db.getRecordingById).mockClear()
    vi.doMock('../config', () => ({
      getConfig: () => ({
        privacy: { enableVoiceprintCapture: false, excludeVoiceprintsFromBackup: true },
      }),
    }))
    try {
      const { captureVoiceprint: cv } = await import('../voiceprint-service')
      const res = await cv('rec_1', 'A', 'c_1')
      expect(res.captured).toBe(false)
      expect(res.reason).toBe('voiceprint-disabled')
      expect(vi.mocked(db.getRecordingById)).not.toHaveBeenCalled()
      expect(vi.mocked(embedSamples)).not.toHaveBeenCalled()
      expect(vi.mocked(db.insertVoiceprint)).not.toHaveBeenCalled()
    } finally {
      vi.doUnmock('../config')
      vi.resetModules()
    }
  })

  // Privacy gate — the master toggle also disables the auto-embed path:
  // embedRecordingLabels is a no-op (never reaches insertLabelEmbedding) when
  // enableVoiceprintCapture is false. Mirrors 8f's mock/teardown so it can't leak.
  it('8g. privacy toggle disabled → embedRecordingLabels skipped, NO label embedding, no throw', async () => {
    vi.mocked(db.insertLabelEmbedding).mockReset()
    vi.resetModules()
    vi.doMock('../config', () => ({
      getConfig: () => ({
        privacy: { enableVoiceprintCapture: false, excludeVoiceprintsFromBackup: true },
      }),
    }))
    try {
      const { embedRecordingLabels } = await import('../voiceprint-service')
      await embedRecordingLabels('r1')
      expect(vi.mocked(db.insertLabelEmbedding)).not.toHaveBeenCalled()
    } finally {
      vi.doUnmock('../config')
      vi.resetModules()
    }
  })

  // -------------------------------------------------------------------------
  // Task 5: embedRecordingLabels — auto-embed every clean label, off-thread.
  // Reuses the suite's sherpa stub (isVoiceprintAvailable() true), the
  // beforeEach embedSamples mock (Float32Array(256)), and the child_process
  // PCM-decode mock. Label A (12 s clean ≥ 10 s) is embedded once; label B
  // (2 s clean < 10 s) is skipped — verified through the REAL
  // collectCleanSpeechMs gate, not a weakened assertion.
  // -------------------------------------------------------------------------
  it('embedRecordingLabels embeds each ≥10s-clean label and persists, skips short labels', async () => {
    const db = await import('../database')
    vi.mocked(db.getRecordingById).mockReturnValue({ id: 'r1', file_path: '/r/r1.wav' } as never)
    vi.mocked(db.getTranscriptByRecordingId).mockReturnValue({ id: 't1', turns: JSON.stringify([
      { speaker: 'A', startMs: 0, endMs: 12000, text: 'long' },
      { speaker: 'B', startMs: 12000, endMs: 14000, text: 'short' } // 2s < 10s → skip
    ]) } as never)
    vi.mocked(db.insertLabelEmbedding).mockReset()
    const { embedRecordingLabels } = await import('../voiceprint-service')
    await embedRecordingLabels('r1')
    expect(vi.mocked(db.insertLabelEmbedding)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(db.insertLabelEmbedding).mock.calls[0][0].file_label).toBe('A')
  })

  it('embedRecordingLabels is idempotent: existing rows short-circuit without re-embed', async () => {
    const db = await import('../database')
    vi.mocked(db.getRecordingById).mockReturnValue({ id: 'r1', file_path: '/r/r1.wav' } as never)
    vi.mocked(db.getTranscriptByRecordingId).mockReturnValue({ id: 't1', turns: JSON.stringify([
      { speaker: 'A', startMs: 0, endMs: 12000, text: 'long' }
    ]) } as never)
    vi.mocked(db.getLabelEmbeddingsForRecording).mockReturnValue([
      {
        id: 'le_r1_drun_existing_A',
        recording_id: 'r1',
        transcript_id: 't1',
        diarization_run_id: 'drun_existing',
        file_label: 'A',
        model_id: VOICEPRINT_MODEL_ID,
        model_version: 1,
        dim: 256,
        embedding: new Uint8Array(256 * 4),
        clean_speech_ms: 12000,
      }
    ] as never)
    vi.mocked(db.insertLabelEmbedding).mockReset()
    vi.mocked(embedSamples).mockClear()
    const { embedRecordingLabels } = await import('../voiceprint-service')
    await embedRecordingLabels('r1')
    expect(vi.mocked(embedSamples)).not.toHaveBeenCalled()
    expect(vi.mocked(db.insertLabelEmbedding)).not.toHaveBeenCalled()
  })

  it('embedRecordingLabels mints a run id and writes deterministic ids when table is empty', async () => {
    const db = await import('../database')
    vi.mocked(db.getRecordingById).mockReturnValue({ id: 'r1', file_path: '/r/r1.wav' } as never)
    vi.mocked(db.getTranscriptByRecordingId).mockReturnValue({ id: 't1', turns: JSON.stringify([
      { speaker: 'A', startMs: 0, endMs: 12000, text: 'long' }
    ]) } as never)
    vi.mocked(db.getLabelEmbeddingsForRecording).mockReturnValue([] as never)
    vi.mocked(db.insertLabelEmbedding).mockReset()
    const { embedRecordingLabels } = await import('../voiceprint-service')
    await embedRecordingLabels('r1')
    expect(vi.mocked(db.insertLabelEmbedding)).toHaveBeenCalledTimes(1)
    const row = vi.mocked(db.insertLabelEmbedding).mock.calls[0][0]
    expect(row.id).toMatch(/^le_r1_drun_[A-Za-z0-9\-_]+_A$/)
    expect(row.diarization_run_id).toMatch(/^drun_/)
  })

  it('banking gate: skips capture when a mixed suggestion exists for the label', async () => {
    const db = await import('../database')
    vi.mocked(db.getRecordingById).mockReturnValue({ file_path: '/recordings/m.hda' } as never)
    vi.mocked(db.getTranscriptByRecordingId).mockReturnValue({
      turns: JSON.stringify(longTurns),
    } as never)
    vi.mocked(db.getSuggestionsForRecording).mockReturnValue([
      { id: 's1', recording_id: 'rec_1', kind: 'mixed', target_label: 'A', status: 'pending' }
    ] as never)
    vi.mocked(db.insertVoiceprint).mockReset()
    const { captureVoiceprint: cv } = await import('../voiceprint-service')
    const res = await cv('rec_1', 'A', 'c_1')
    expect(res.captured).toBe(false)
    expect(res.reason).toBe('label-suspected-mixed')
    expect(res.cleanSpeechMs).toBe(12000)
    expect(vi.mocked(db.insertVoiceprint)).not.toHaveBeenCalled()
  })

  it('banking gate: flags low quality_score when new print is inconsistent with existing prints', async () => {
    const db = await import('../database')
    vi.mocked(db.getRecordingById).mockReturnValue({ file_path: '/recordings/m.hda' } as never)
    vi.mocked(db.getTranscriptByRecordingId).mockReturnValue({
      turns: JSON.stringify(longTurns),
    } as never)
    vi.mocked(db.getSuggestionsForRecording).mockReturnValue([] as never)
    const inconsistent = new Float32Array(256).fill(-0.5)
    vi.mocked(db.getActiveVoiceprintsByContactId).mockReturnValue([
      {
        id: 'vp_old',
        contact_id: 'c_1',
        model_id: VOICEPRINT_MODEL_ID,
        dim: 256,
        embedding: new Uint8Array(inconsistent.buffer, inconsistent.byteOffset, inconsistent.byteLength),
        created_at: '2026-01-01T00:00:00.000Z',
      }
    ] as never)
    vi.mocked(db.insertVoiceprint).mockReset()
    const { captureVoiceprint: cv } = await import('../voiceprint-service')
    const res = await cv('rec_1', 'A', 'c_1')
    expect(res.captured).toBe(true)
    const row = vi.mocked(db.insertVoiceprint).mock.calls[0][0]
    expect(row.quality_score).toBe(0.3)
  })

  it('banking gate: leaves quality_score null when new print is consistent with existing prints', async () => {
    const db = await import('../database')
    vi.mocked(db.getRecordingById).mockReturnValue({ file_path: '/recordings/m.hda' } as never)
    vi.mocked(db.getTranscriptByRecordingId).mockReturnValue({
      turns: JSON.stringify(longTurns),
    } as never)
    vi.mocked(db.getSuggestionsForRecording).mockReturnValue([] as never)
    const consistent = new Float32Array(256).fill(0.5)
    vi.mocked(db.getActiveVoiceprintsByContactId).mockReturnValue([
      {
        id: 'vp_old',
        contact_id: 'c_1',
        model_id: VOICEPRINT_MODEL_ID,
        dim: 256,
        embedding: new Uint8Array(consistent.buffer, consistent.byteOffset, consistent.byteLength),
        created_at: '2026-01-01T00:00:00.000Z',
      }
    ] as never)
    vi.mocked(db.insertVoiceprint).mockReset()
    const { captureVoiceprint: cv } = await import('../voiceprint-service')
    const res = await cv('rec_1', 'A', 'c_1')
    expect(res.captured).toBe(true)
    const row = vi.mocked(db.insertVoiceprint).mock.calls[0][0]
    expect(row.quality_score).toBeNull()
  })

  it('banking gate: created_from is confirmed when the 4th arg is passed, manual by default', async () => {
    const db = await import('../database')
    vi.mocked(db.getRecordingById).mockReturnValue({ file_path: '/recordings/m.hda' } as never)
    vi.mocked(db.getTranscriptByRecordingId).mockReturnValue({
      turns: JSON.stringify(longTurns),
    } as never)
    vi.mocked(db.getSuggestionsForRecording).mockReturnValue([] as never)
    vi.mocked(db.getActiveVoiceprintsByContactId).mockReturnValue([] as never)
    vi.mocked(db.insertVoiceprint).mockReset()
    const { captureVoiceprint: cv } = await import('../voiceprint-service')
    await cv('rec_1', 'A', 'c_1', 'confirmed')
    expect(vi.mocked(db.insertVoiceprint).mock.calls[0][0].created_from).toBe('confirmed')
    await cv('rec_1', 'A', 'c_1')
    expect(vi.mocked(db.insertVoiceprint).mock.calls[1][0].created_from).toBe('manual')
  })

  it('superseded race guard: skips banking when the label is now assigned to a different contact', async () => {
    vi.mocked(db.getRecordingSpeaker).mockReturnValue({
      recording_id: 'rec_1',
      file_label: 'A',
      contact_id: 'c_other',
      source: 'user',
    } as never)
    const { captureVoiceprint: cv } = await import('../voiceprint-service')
    const res = await cv('rec_1', 'A', 'c_1')
    expect(res.captured).toBe(false)
    expect(res.reason).toBe('superseded')
    expect(vi.mocked(db.insertVoiceprint)).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Phase 2B: sliceLabelWindows / embedLabelWindows (pure + off-thread wrapper)
// ---------------------------------------------------------------------------
describe('sliceLabelWindows() — fixed-window label slicer (§3 unit 4)', () => {
  // 16 kHz mono s16le: 1 ms = 32 bytes. Build 30 s of PCM with recognisable samples.
  const THIRTY_SEC_PCM = Buffer.alloc(30_000 * 32)
  for (let i = 0; i < THIRTY_SEC_PCM.length; i += 2) {
    THIRTY_SEC_PCM.writeInt16LE((i % 4 === 0) ? 1000 : -1000, i)
  }

  const turns: Turn[] = [
    { speaker: 'A', startMs: 0, endMs: 30_000, text: 'all A' }
  ]

  it('emits the expected number of fixed-length windows and drops a short tail', () => {
    const windows = sliceLabelWindows(THIRTY_SEC_PCM, turns, 'A', 20_000, 10_000)
    const windowSamples = (20_000 / 1000) * 16000
    const minWindowSamples = windowSamples / 2
    // 30 s source, 20 s windows, 10 s hop → windows at 0s, 10s, 20s; 20s-30s tail is kept.
    expect(windows.length).toBe(3)
    expect(windows[0].length).toBe(windowSamples)
    expect(windows[1].length).toBe(windowSamples)
    expect(windows[2].length).toBe(minWindowSamples)
  })

  it('caps total accumulated samples at MAX_EMBED_SPEECH_MS', async () => {
    const { sliceLabelWindows: slw, MAX_EMBED_SPEECH_MS } = await import('../voiceprint-service')
    const capSamples = (MAX_EMBED_SPEECH_MS / 1000) * 16000
    const longPcm = Buffer.alloc(70_000 * 32)
    const longTurns: Turn[] = [{ speaker: 'A', startMs: 0, endMs: 70_000, text: 'long' }]
    // Non-overlapping 20 s windows: 70 s input capped to 60 s → exactly 3 windows.
    const windows = slw(longPcm, longTurns, 'A', 20_000, 20_000)
    expect(windows.reduce((sum, w) => sum + w.length, 0)).toBe(capSamples)
  })

  it('returns [] when total label samples are below half a window', () => {
    const shortPcm = Buffer.alloc(3_000 * 32) // 3 s < 10 s min
    const shortTurns: Turn[] = [{ speaker: 'A', startMs: 0, endMs: 3_000, text: 'short' }]
    expect(sliceLabelWindows(shortPcm, shortTurns, 'A', 20_000, 10_000)).toEqual([])
  })

  it('returns correct sample values from a synthetic Buffer', () => {
    // 2 s of PCM: sample pattern 0, 32767, 0, -32768 repeating.
    const pcm = Buffer.alloc(2_000 * 32)
    for (let i = 0; i < pcm.length; i += 4) {
      pcm.writeInt16LE(0, i)
      pcm.writeInt16LE(32767, i + 2)
    }
    for (let i = 4; i < pcm.length; i += 4) {
      pcm.writeInt16LE(0, i)
      pcm.writeInt16LE(-32768, i + 2)
    }
    // 500 ms windows / 500 ms hop on 2 s source → 4 equal-length windows.
    const windows = sliceLabelWindows(pcm, [{ speaker: 'A', startMs: 0, endMs: 2_000, text: 'x' }], 'A', 500, 500)
    expect(windows.length).toBe(4)
    expect(windows[0][0]).toBeCloseTo(0, 5)
    expect(windows[0][1]).toBeCloseTo(32767 / 32768, 4)
    expect(windows[0][2]).toBeCloseTo(0, 5)
    expect(windows[0][3]).toBeCloseTo(-32768 / 32768, 5)
  })
})

describe('embedLabelWindows() — off-thread window embedder', () => {
  it('never throws and returns a list even when decode is unavailable', async () => {
    const db = await import('../database')
    vi.mocked(db.getRecordingById).mockReturnValue({ file_path: null } as never)
    const { embedLabelWindows: elw } = await import('../voiceprint-service')
    const res = await elw('r1', 'A')
    expect(Array.isArray(res)).toBe(true)
    expect(res.length).toBe(0)
  })
})

describe('embedRecordingLabels() — per-recording label embeddings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(db.getRecordingById).mockReturnValue({ id: 'rec_1', file_path: '/r/rec.wav' } as never)
    vi.mocked(db.getTranscriptByRecordingId).mockReturnValue({
      id: 't_1',
      turns: JSON.stringify([{ speaker: 'A', startMs: 0, endMs: 12_000, text: 'hello' }]),
    } as never)
    vi.mocked(embedSamples).mockResolvedValue(new Float32Array(256).fill(0.5))
  })

  it('deletes stale-model embeddings and re-embeds with the active model', async () => {
    vi.mocked(db.getLabelEmbeddingsForRecording).mockReturnValue([
      {
        id: 'le_stale',
        recording_id: 'rec_1',
        file_label: 'A',
        model_id: 'old_model',
        model_version: 1,
        dim: 256,
        embedding: new Uint8Array(1024),
        clean_speech_ms: 12_000,
      }
    ] as never)
    const { embedRecordingLabels } = await import('../voiceprint-service')
    await embedRecordingLabels('rec_1')
    expect(vi.mocked(db.deleteLabelEmbeddingsForRecording)).toHaveBeenCalledWith('rec_1')
    expect(vi.mocked(db.insertLabelEmbedding)).toHaveBeenCalledTimes(1)
    const row = vi.mocked(db.insertLabelEmbedding).mock.calls[0][0]
    expect(row.model_id).toBe(VOICEPRINT_MODEL_ID)
    expect(row.file_label).toBe('A')
  })

  it('is idempotent when embeddings already use the active model', async () => {
    vi.mocked(db.getLabelEmbeddingsForRecording).mockReturnValue([
      {
        id: 'le_ok',
        recording_id: 'rec_1',
        file_label: 'A',
        model_id: VOICEPRINT_MODEL_ID,
        model_version: 1,
        dim: 256,
        embedding: new Uint8Array(1024),
        clean_speech_ms: 12_000,
      }
    ] as never)
    const { embedRecordingLabels } = await import('../voiceprint-service')
    await embedRecordingLabels('rec_1')
    expect(vi.mocked(db.deleteLabelEmbeddingsForRecording)).not.toHaveBeenCalled()
    expect(vi.mocked(db.insertLabelEmbedding)).not.toHaveBeenCalled()
  })
})
