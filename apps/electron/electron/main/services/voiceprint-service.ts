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
import { promisify } from 'util'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { app } from 'electron'
import { resolveFfmpegPath } from './asr/audio-normalize'
import { getRecordingById, getTranscriptByRecordingId, insertVoiceprint } from './database'
import type { Turn } from './asr/asr-provider'

// promisify(execFile) — same primitive as the sibling ffmpeg service
// (audio-normalize.ts) so the two ffmpeg call sites stay consistent. With
// { encoding: 'buffer' } the resolved value is { stdout: Buffer; stderr: Buffer }
// and a non-zero exit rejects with an Error carrying the captured `.stderr`.
const execFileAsync = promisify(execFile)
// Raw PCM is far larger than MP3 (~32000 bytes/s mono); lift the stdout cap well
// above the default 1 MB. A ~2.3 h recording overflows even this 256 MB cap and
// rejects with a "maxBuffer exceeded" error, which is handled like any decode
// failure below.
const PCM_MAX_BUFFER = 256 * 1024 * 1024

/**
 * Decode the WHOLE recording to 16 kHz mono signed-16-bit little-endian PCM on
 * stdout (`pipe:1`) and return it as a single raw `Buffer`. DISTINCT from the
 * Whisper path's MP3 output (§6.7) — no `-b:a`, format is pcm_s16le.
 *
 * This decodes the entire file in ONE ffmpeg invocation; per-label slicing by
 * turn time-ranges and the s16le→Float32 conversion sherpa wants both happen in
 * the CALLER (D4-T5), operating in PCM space (16 kHz × 2 bytes/sample = 32000
 * bytes/s) — that avoids one ffmpeg spawn per turn.
 *
 * Throws on ffmpeg failure (incl. maxBuffer overflow) so the caller can skip
 * enrollment while keeping the speaker→contact mapping (§8). The thrown message
 * preserves the captured stderr tail for diagnostics.
 */
export async function decodeRecordingPcm16k(filePath: string): Promise<Buffer> {
  const ffmpeg = resolveFfmpegPath()
  const args = ['-y', '-i', filePath, '-ar', '16000', '-ac', '1', '-f', 'pcm_s16le', 'pipe:1']
  try {
    const { stdout } = await execFileAsync(ffmpeg, args, {
      encoding: 'buffer',
      maxBuffer: PCM_MAX_BUFFER
    })
    return stdout as Buffer
  } catch (e) {
    // Prefer the captured stderr (attached to the rejected error by execFile)
    // over the generic message so diagnostics show WHY ffmpeg failed.
    const err = e as { stderr?: string | Buffer; message?: string }
    const stderr = err.stderr != null ? String(err.stderr) : undefined
    const detail = (stderr ?? err.message ?? String(e)).slice(-200)
    throw new Error(`pcm decode failed for ${filePath}: ${detail}`)
  }
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

// ---------------------------------------------------------------------------
// D4-T5: captureVoiceprint orchestrator (§6.7, AC4)
// ---------------------------------------------------------------------------

export interface CaptureResult {
  captured: boolean
  reason?: string
}

// Lazy-init the extractor on first captureVoiceprint call (§6.7). null until
// first capture; ctor can throw on bad/missing model — degrades to "unavailable".
type SherpaExtractor = InstanceType<SherpaModule['SpeakerEmbeddingExtractor']>
let extractor: SherpaExtractor | null = null

function getExtractor(): SherpaExtractor | null {
  if (!sherpa) return null
  if (extractor) return extractor
  try {
    const modelPath = app.isPackaged
      ? join(process.resourcesPath, 'models', `${VOICEPRINT_MODEL_ID}.onnx`)
      : join(app.getAppPath(), 'resources', 'models', `${VOICEPRINT_MODEL_ID}.onnx`)
    extractor = new sherpa.SpeakerEmbeddingExtractor({ model: modelPath, numThreads: 1, debug: false })
    return extractor
  } catch (e) {
    console.warn(`[Voiceprint] extractor init failed — capture disabled: ${(e as Error).message}`)
    return null
  }
}

/** Convert 16 kHz s16le mono PCM bytes to a Float32Array of the label's
 *  clean turn samples (32 bytes/ms = 16000 Hz × 2 bytes). Exported for tests. */
export function pcmToFloat32(pcm: Buffer, turns: Turn[], label: string): Float32Array {
  const BYTES_PER_MS = 32 // 16000 samples/s × 2 bytes/sample ÷ 1000 ms/s
  const out: number[] = []
  for (const t of turns) {
    if (t.speaker !== label) continue
    const start = Math.max(0, Math.floor(t.startMs * BYTES_PER_MS))
    const end = Math.min(pcm.length, Math.floor(t.endMs * BYTES_PER_MS))
    for (let i = start; i + 1 < end; i += 2) {
      out.push(pcm.readInt16LE(i) / 32768)
    }
  }
  return Float32Array.from(out)
}

/** Float32 embedding → little-endian byte BLOB (4 bytes/element). */
function embeddingToBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength)
}

/**
 * Capture-only voiceprint hook (§6.7, AC4). Fired by the speakers:assign IPC
 * after the recording_speakers row is written. NEVER throws — every failure
 * mode returns { captured: false, reason } so the speaker mapping always succeeds.
 *
 * Outcomes (AC4):
 *   (a) ≥10 s clean speech + sherpa available → one voiceprints row stored.
 *   (b) <10 s clean speech → skip (reason: 'insufficient clean speech').
 *   (c) ffmpeg decode failure → skip (reason: 'decode failed: …').
 *   (d) sherpa unavailable → skip (reason: 'voiceprint unavailable').
 *   (e) file_path null/missing → skip (reason: 'audio file not downloaded').
 */
export async function captureVoiceprint(
  recordingId: string,
  fileLabel: string,
  contactId: string,
): Promise<CaptureResult> {
  const ext = getExtractor()
  if (!ext) return { captured: false, reason: 'voiceprint unavailable' }

  const recording = getRecordingById(recordingId)
  if (!recording?.file_path) return { captured: false, reason: 'audio file not downloaded' }

  const transcript = getTranscriptByRecordingId(recordingId)
  let turns: Turn[] = []
  try {
    turns = transcript?.turns ? (JSON.parse(transcript.turns) as Turn[]) : []
  } catch {
    turns = []
  }

  const cleanMs = collectCleanSpeechMs(turns, fileLabel)
  if (cleanMs < MIN_CLEAN_SPEECH_MS) {
    return {
      captured: false,
      reason: `insufficient clean speech (${cleanMs} ms < ${MIN_CLEAN_SPEECH_MS} ms)`,
    }
  }

  let pcm: Buffer
  try {
    pcm = await decodeRecordingPcm16k(recording.file_path)
  } catch (e) {
    console.warn(`[Voiceprint] decode failed for recording ${recordingId}: ${(e as Error).message}`)
    return { captured: false, reason: `decode failed: ${(e as Error).message}` }
  }

  const samples = pcmToFloat32(pcm, turns, fileLabel)
  if (samples.length === 0) return { captured: false, reason: 'no usable samples after slicing' }

  try {
    const stream = ext.createStream()
    ext.acceptWaveform(stream, { sampleRate: 16000, samples })
    if (!ext.isReady(stream)) return { captured: false, reason: 'extractor not ready' }
    const embedding = ext.compute(stream)

    insertVoiceprint({
      id: `vp_${randomUUID()}`,
      contact_id: contactId,
      model_id: VOICEPRINT_MODEL_ID,
      dim: ext.dim,
      embedding: embeddingToBlob(embedding),
    })
    return { captured: true }
  } catch (e) {
    console.warn(`[Voiceprint] embedding failed for recording ${recordingId}: ${(e as Error).message}`)
    return { captured: false, reason: `embedding failed: ${(e as Error).message}` }
  }
}
