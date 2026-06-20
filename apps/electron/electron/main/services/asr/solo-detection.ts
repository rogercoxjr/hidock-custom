import type { Turn, SpeakerOptions } from './asr-provider'

export const SOLO_DOMINANCE_FRACTION = 0.97
export const SOLO_MINOR_MAX_MS = 3000

export type DiarizationFailureReason =
  | 'no_turns'
  | 'hit_ceiling'
  | 'over_floor'
  | null

export interface RunOutcome {
  labelCount: number
  isSolo: boolean
  soloReason: 'single_label' | 'dominant_single_speaker' | null
  failure: DiarizationFailureReason
}

/** Classify a diarization run outcome from the returned turns and the options sent.
 *  Pure, deterministic, and independent of any embedding-based matcher. */
export function classifyRunOutcome(
  turns: Turn[] | undefined,
  optionsSent: SpeakerOptions | null,
  durationMs: number | null | undefined
): RunOutcome {
  const labelCount = turns && turns.length > 0 ? new Set(turns.map((t) => t.speaker)).size : 0

  let isSolo = false
  let soloReason: RunOutcome['soloReason'] = null

  if (labelCount <= 1) {
    isSolo = true
    soloReason = 'single_label'
  } else if (labelCount === 2 && turns) {
    const talkByLabel = new Map<string, number>()
    let totalTalkMs = 0
    for (const t of turns) {
      const dur = Math.max(0, t.endMs - t.startMs)
      talkByLabel.set(t.speaker, (talkByLabel.get(t.speaker) ?? 0) + dur)
      totalTalkMs += dur
    }

    const sorted = [...talkByLabel.entries()].sort((a, b) => b[1] - a[1])
    const [, dominantMs] = sorted[0]
    const [, minorMs] = sorted[1]

    if (
      totalTalkMs > 0 &&
      dominantMs / totalTalkMs >= SOLO_DOMINANCE_FRACTION &&
      minorMs < SOLO_MINOR_MAX_MS
    ) {
      isSolo = true
      soloReason = 'dominant_single_speaker'
    }
  }

  let failure: DiarizationFailureReason = null
  if (labelCount === 0 && durationMs != null && durationMs > 0) {
    failure = 'no_turns'
  } else if (optionsSent && labelCount === optionsSent.max_speakers_expected) {
    failure = 'hit_ceiling'
  } else if (optionsSent && labelCount > optionsSent.max_speakers_expected) {
    failure = 'over_floor'
  }

  return { labelCount, isSolo, soloReason, failure }
}
