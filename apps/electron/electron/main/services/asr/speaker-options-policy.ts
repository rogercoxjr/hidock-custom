import type { SpeakerOptions } from './asr-provider'

export interface SpeakerOptionsPolicy {
  /** Master switch for sending the hint. */
  speakerOptionsEnabled: boolean
  /** Floor sent to the diarizer. */
  minSpeakers: number
  /** Ceiling sent to the diarizer. */
  maxSpeakers: number
  /** AssemblyAI applies no max limit under this duration, so skip the hint there. */
  minDurationMsForHint: number
  /** Model-version tag; re-tune if the speech model changes. */
  policyVersion: number
}

export const DEFAULT_SPEAKER_OPTIONS_POLICY: SpeakerOptionsPolicy = {
  speakerOptionsEnabled: true,
  // Per spec, the {min:1, max:8} pair ships only after the calibration gate
  // (aai-diarization-tune.mjs with real solo/1:1/medical/church audio) passes.
  // Until that gate is explicitly run and passed, use rev-2 §9's recommended floor.
  minSpeakers: 2,
  maxSpeakers: 8,
  minDurationMsForHint: 120000,
  policyVersion: 1
}

/** Returns the conservative static speaker_options to send, or null to send NONE.
 *  Pure and config-overridable. */
export function computeSpeakerOptions(
  durationMs: number | null | undefined,
  policy?: Partial<SpeakerOptionsPolicy>
): SpeakerOptions | null {
  const p = { ...DEFAULT_SPEAKER_OPTIONS_POLICY, ...policy }
  if (durationMs == null || durationMs < p.minDurationMsForHint || !p.speakerOptionsEnabled) {
    return null
  }
  return {
    min_speakers_expected: p.minSpeakers,
    max_speakers_expected: p.maxSpeakers
  }
}
