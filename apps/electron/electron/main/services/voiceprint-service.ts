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

// The WeSpeaker model bundled in app resources (electron-builder asarUnpack).
// model_id is persisted on every voiceprints row so a future model swap can
// re-embed (spec §6.3).
export const VOICEPRINT_MODEL_ID = 'wespeaker_en_voxceleb_resnet34_LM'

// ---------------------------------------------------------------------------
// Module-level optional-dependency load. A failed import sets the addon to
// null; isVoiceprintAvailable() reports it. One log line, no throw (§6.7).
//
// Uses top-level await so the import completes before any caller reads the
// availability flag. Dynamic import() is used rather than require() so that
// Vitest's vi.mock can intercept it in tests (Vitest v4 patches ESM imports
// but not CJS require() calls).
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
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  sherpa = (await import('sherpa-onnx-node')) as SherpaModule
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
