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
import { getRecordingById, getTranscriptByRecordingId, insertVoiceprint, insertLabelEmbedding } from './database'
import { embedSamples } from './voiceprint-worker-pool'
import type { Turn } from './asr/asr-provider'

// promisify(execFile) — same primitive as the sibling ffmpeg service
// (audio-normalize.ts) so the two ffmpeg call sites stay consistent. With
// { encoding: 'buffer' } the resolved value is { stdout: Buffer; stderr: Buffer }
// and a non-zero exit rejects with an Error carrying the captured `.stderr`.
const execFileAsync = promisify(execFile)
// Raw PCM is far larger than MP3 (~32000 bytes/s mono); lift the stdout cap well
// above the default 1 MB. A ffmpeg failure (incl. maxBuffer overflow) is handled
// like any decode failure below.
const PCM_MAX_BUFFER = 2 * 1024 * 1024 * 1024 // 2 GB: a ~2.3h cap silently dropped long Service recordings

/**
 * Decode the WHOLE recording to 16 kHz mono signed-16-bit little-endian PCM on
 * stdout (`pipe:1`) and return it as a single raw `Buffer`. DISTINCT from the
 * Whisper path's MP3 output (§6.7) — no `-b:a`; the raw-PCM muxer is `-f s16le`.
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
  // `-f s16le` selects the raw-PCM MUXER. `pcm_s16le` is the CODEC name, NOT an output
  // format — `-f pcm_s16le` errors "Requested output format 'pcm_s16le' is not known".
  const args = ['-y', '-i', filePath, '-ar', '16000', '-ac', '1', '-f', 's16le', 'pipe:1']
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

// ERes2Net (3D-Speaker, en VoxCeleb, 16k) — adopted rev 2 (Phase-0: ~0.8% cross-recording
// EER on real far-field P1 audio vs WeSpeaker's 26.8%). 256-dim → no voiceprints storage
// migration. Per-voiceprint model_id makes a future swap re-embeddable.
export const VOICEPRINT_MODEL_ID = '3dspeaker_eres2net_en_voxceleb'

// ---------------------------------------------------------------------------
// Module-level optional-dependency load. A failed require sets the addon to
// null; isVoiceprintAvailable() reports it. One log line, no throw (§6.7).
//
// Synchronous require() (NOT top-level await): the Electron main process bundles
// to CJS, where top-level await is invalid and Rollup would drop/break it. The
// require lives in a try/catch so a missing native addon (optionalDependencies
// no-op, non-Windows, broken prebuild) degrades silently — one log line, no throw.
// ---------------------------------------------------------------------------
// sherpa-onnx-node's OnlineStream: acceptWaveform + inputFinished live HERE,
// not on the extractor (verified against the real addon, 2026-06-18).
type SherpaStream = {
  acceptWaveform(wave: { sampleRate: number; samples: Float32Array }): void
  inputFinished(): void
}
type SherpaModule = {
  SpeakerEmbeddingExtractor: new (config: unknown) => {
    dim: number
    createStream(): SherpaStream
    isReady(stream: SherpaStream): boolean
    // enableExternalBuffer defaults to true in the addon; we MUST pass false so it
    // allocates a V8-owned buffer (Electron's V8 cage rejects external buffers).
    compute(stream: SherpaStream, enableExternalBuffer?: boolean): Float32Array
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

/** Cap the clean speech fed to the extractor. A speaker embedding saturates well
 *  under a minute; 60 s bounds compute() time (and the slicing loop) so a long
 *  recording can't freeze the main thread. Well above MIN_CLEAN_SPEECH_MS. */
export const MAX_EMBED_SPEECH_MS = 60_000

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

// NOTE: the in-process extractor (getExtractor/compute) was removed when embedding
// moved off-thread (see voiceprint-worker-pool). The sherpa require + isVoiceprintAvailable()
// above stay as the availability probe; the actual compute now runs in the utilityProcess
// worker, which loads sherpa itself from modelPath().

/** Convert 16 kHz s16le mono PCM bytes to a Float32Array of the label's
 *  clean turn samples (32 bytes/ms = 16000 Hz × 2 bytes). Exported for tests. */
export function pcmToFloat32(pcm: Buffer, turns: Turn[], label: string): Float32Array {
  const BYTES_PER_MS = 32 // 16000 samples/s × 2 bytes/sample ÷ 1000 ms/s
  const MAX_SAMPLES = (MAX_EMBED_SPEECH_MS / 1000) * 16000 // 60 s cap (see MAX_EMBED_SPEECH_MS)
  const out: number[] = []
  for (const t of turns) {
    if (t.speaker !== label) continue
    const start = Math.max(0, Math.floor(t.startMs * BYTES_PER_MS))
    const end = Math.min(pcm.length, Math.floor(t.endMs * BYTES_PER_MS))
    for (let i = start; i + 1 < end; i += 2) {
      out.push(pcm.readInt16LE(i) / 32768)
      if (out.length >= MAX_SAMPLES) return Float32Array.from(out) // stop once capped
    }
  }
  return Float32Array.from(out)
}

/** Float32 embedding → little-endian byte BLOB (4 bytes/element). */
function embeddingToBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength)
}

/** Resolve the on-disk model path the same way getExtractor() does — the
 *  utilityProcess worker loads sherpa from this path off the main thread. */
function modelPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'models', `${VOICEPRINT_MODEL_ID}.onnx`)
    : join(app.getAppPath(), 'resources', 'models', `${VOICEPRINT_MODEL_ID}.onnx`)
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
  if (!isVoiceprintAvailable()) return { captured: false, reason: 'voiceprint unavailable' }

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

  // Embed OFF the main thread in a utilityProcess (see voiceprint-worker-pool): the
  // synchronous sherpa compute() can no longer block the UI. embedSamples never throws;
  // it resolves null on any worker failure so the speaker→contact mapping always succeeds.
  const embedding = await embedSamples(modelPath(), 16000, samples)
  if (!embedding) return { captured: false, reason: 'embedding failed (worker)' }
  insertVoiceprint({
    id: `vp_${randomUUID()}`,
    contact_id: contactId,
    model_id: VOICEPRINT_MODEL_ID,
    dim: embedding.length,
    embedding: embeddingToBlob(embedding),
  })
  return { captured: true }
}

/** Embed EVERY label of a recording (clean-gated), off the main thread, persisting to
 *  recording_label_embeddings. Lazy/deferred caller (Phase 3 wires when the panel opens).
 *  Never throws; skips labels < MIN_CLEAN_SPEECH_MS. */
export async function embedRecordingLabels(recordingId: string): Promise<void> {
  if (!isVoiceprintAvailable()) return
  const recording = getRecordingById(recordingId)
  if (!recording?.file_path) return
  const transcript = getTranscriptByRecordingId(recordingId)
  let turns: Turn[] = []
  try { turns = transcript?.turns ? (JSON.parse(transcript.turns) as Turn[]) : [] } catch { turns = [] }
  if (turns.length === 0) return

  let pcm: Buffer
  try { pcm = await decodeRecordingPcm16k(recording.file_path) } catch (e) {
    console.warn(`[Voiceprint] embedRecordingLabels decode failed (${recordingId}): ${(e as Error).message}`); return
  }
  const labels = [...new Set(turns.map((t) => t.speaker))]
  for (const label of labels) {
    if (collectCleanSpeechMs(turns, label) < MIN_CLEAN_SPEECH_MS) continue
    const samples = pcmToFloat32(pcm, turns, label)
    if (samples.length === 0) continue
    const embedding = await embedSamples(modelPath(), 16000, samples)
    if (!embedding) continue
    insertLabelEmbedding({
      id: `le_${randomUUID()}`, recording_id: recordingId, transcript_id: transcript?.id ?? null,
      file_label: label, model_id: VOICEPRINT_MODEL_ID, model_version: 1, dim: embedding.length,
      embedding: embeddingToBlob(embedding), clean_speech_ms: collectCleanSpeechMs(turns, label),
      turn_count: turns.filter((t) => t.speaker === label).length, quality_score: null, status: 'ok'
    })
  }
}
