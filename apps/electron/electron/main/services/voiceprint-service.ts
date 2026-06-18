/**
 * Voiceprint capture hook — speaker-diarization D4 (spec §6.7).
 *
 * v1 = CAPTURE ONLY. Nothing reads voiceprints in v1 (the matcher is Phase 2).
 * On every confirmed speaker→contact mapping (speakers:assign IPC) we pool the
 * label's clean speech, decode it to 16 kHz mono PCM with ffmpeg-static, embed
 * it with sherpa-onnx-node (WeSpeaker), and store a BLOB in `voiceprints`.
 *
 * Graceful degradation (§6.7): sherpa-onnx-node is an OPTIONAL dependency
 * (prebuilt Windows-x64 addon). If it fails to load — non-Windows, missing
 * addon, optionalDependencies no-op — the feature is SILENTLY disabled: one
 * operator log line, no toast; mapping still succeeds. AC4 covers both paths.
 */
import { execFile } from 'child_process'
import { resolveFfmpegPath } from './asr/audio-normalize'
import type { Turn } from './asr/asr-provider'

// Raw PCM is far larger than MP3; lift the stdout cap well above the default 1 MB.
const PCM_MAX_BUFFER = 256 * 1024 * 1024

/**
 * Decode the whole input to 16 kHz mono signed-16-bit little-endian PCM on
 * stdout (`pipe:1`). DISTINCT from the Whisper path's MP3 output (§6.7) — no
 * `-b:a`, format is pcm_s16le. Returns the raw PCM Buffer; throws on ffmpeg
 * failure so the caller can skip enrollment while keeping the mapping (§8).
 * Segment slicing by the label's turns is applied by the caller in PCM space
 * (16-bit samples → 32000 bytes/s), avoiding one ffmpeg call per turn.
 */
export async function decodeLabelPcm(filePath: string): Promise<Buffer> {
  const ffmpeg = resolveFfmpegPath()
  const args = ['-y', '-i', filePath, '-ar', '16000', '-ac', '1', '-f', 'pcm_s16le', 'pipe:1']
  return new Promise<Buffer>((resolve, reject) => {
    execFile(ffmpeg, args, { encoding: 'buffer', maxBuffer: PCM_MAX_BUFFER }, (err, stdout, _stderr) => {
      if (err) {
        const detail = String((err as { stderr?: string }).stderr ?? err.message).slice(-200)
        reject(new Error(`pcm decode failed for ${filePath}: ${detail}`))
        return
      }
      resolve(stdout as Buffer)
    })
  })
}

// The WeSpeaker model bundled in app resources (electron-builder asarUnpack).
// model_id is persisted on every voiceprints row so a future model swap can
// re-embed (spec §6.3).
export const VOICEPRINT_MODEL_ID = 'wespeaker_en_voxceleb_resnet34_LM'

// ---------------------------------------------------------------------------
// Module-level optional-dependency load. A failed require sets the addon to
// null; isVoiceprintAvailable() reports it. One log line, no throw (§6.7).
//
// Synchronous require() (NOT top-level await): the Electron main process bundles
// to CJS, where top-level await is invalid and Rollup would drop/break it. The
// require lives in a try/catch so a missing native addon (optionalDependencies
// no-op, non-Windows, broken prebuild) degrades silently — one log line, no throw.
// ---------------------------------------------------------------------------
type SherpaModule = {
  SpeakerEmbeddingExtractor: new (config: unknown) => {
    dim: number
    createStream(): unknown
    acceptWaveform(stream: unknown, wave: { sampleRate: number; samples: Float32Array }): void
    isReady(stream: unknown): boolean
    compute(stream: unknown): Float32Array
  }
}

let sherpa: SherpaModule | null = null
try {
  // @ts-ignore - sherpa-onnx-node is an optional native addon; added in D4-T7
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/ban-ts-comment
  sherpa = require('sherpa-onnx-node') as SherpaModule
} catch (e) {
  console.warn(
    `[Voiceprint] sherpa-onnx-node unavailable — voiceprint capture disabled: ${(e as Error).message}`
  )
  sherpa = null
}

/** True when the sherpa-onnx-node addon loaded; false → capture is a no-op. */
export function isVoiceprintAvailable(): boolean {
  return sherpa !== null
}

/** §6.7: require ≥10 s of clean (non-overlapped) speech before enrolling. */
export const MIN_CLEAN_SPEECH_MS = 10_000

/**
 * Sum the milliseconds of `label`'s turns that do NOT overlap any OTHER
 * label's turn (overlap = intersecting time-ranges, §6.7 step 4). Overlapped
 * sub-ranges are subtracted, not the whole turn — partial overlaps keep their
 * clean remainder.
 */
export function collectCleanSpeechMs(turns: Turn[], label: string): number {
  const mine = turns.filter((t) => t.speaker === label)
  const others = turns.filter((t) => t.speaker !== label)
  let cleanMs = 0
  for (const turn of mine) {
    // Build the set of [start,end) sub-ranges of this turn not covered by others.
    let segments: Array<[number, number]> = [[turn.startMs, turn.endMs]]
    for (const o of others) {
      const next: Array<[number, number]> = []
      for (const [s, e] of segments) {
        const oStart = Math.max(s, o.startMs)
        const oEnd = Math.min(e, o.endMs)
        if (oStart >= oEnd) {
          next.push([s, e]) // no intersection — keep whole
          continue
        }
        if (s < oStart) next.push([s, oStart]) // clean left remainder
        if (oEnd < e) next.push([oEnd, e]) // clean right remainder
      }
      segments = next
    }
    for (const [s, e] of segments) cleanMs += e - s
  }
  return cleanMs
}
