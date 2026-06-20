/**
 * Mixed-label detector — flag labels that contain more than one speaker.
 *
 * Pure code: consumes window embeddings and per-window identity candidates.
 */
import { dispersion } from './vector-math'
import type { IdentityScore, MatchThresholds } from './identity-matcher'

export interface WindowedLabel {
  fileLabel: string
  windowEmbs: Float32Array[]
}

export interface MixedFlag {
  fileLabel: string
  reason: 'variance' | 'two-contact'
  dispersion: number
  contactA?: string
  contactB?: string
}

/** Detect labels that appear to contain multiple speakers. */
export function detectMixedLabels(
  windowed: WindowedLabel[],
  perWindowIdentity: Map<string, IdentityScore[][]>,
  thresholds: MatchThresholds
): MixedFlag[] {
  const mixedDispersion = thresholds.mixedDispersion ?? 0.35
  const matchSuggest = thresholds.matchSuggest ?? 0.42
  const flags: MixedFlag[] = []

  for (const { fileLabel, windowEmbs } of windowed) {
    if (windowEmbs.length === 0) continue

    // Signal A: within-label window variance.
    const varDispersion = dispersion(windowEmbs)
    const varianceSignal = varDispersion >= mixedDispersion

    // Signal B: two windows top-match different contacts above matchSuggest.
    let twoContactSignal = false
    let contactA: string | undefined
    let contactB: string | undefined
    const perWindow = perWindowIdentity.get(fileLabel)
    if (perWindow && perWindow.length > 0) {
      const topByWindow = perWindow
        .map((candidates) => candidates[0])
        .filter((top): top is IdentityScore => top !== undefined && top.score >= matchSuggest)
      const topContacts = new Set(topByWindow.map((t) => t.contactId))
      if (topContacts.size >= 2) {
        twoContactSignal = true
        const [first, second] = topContacts
        contactA = first
        contactB = second
      }
    }

    if (varianceSignal && twoContactSignal) {
      // Both signals present: report as two-contact with variance noted via dispersion field.
      flags.push({ fileLabel, reason: 'two-contact', dispersion: varDispersion, contactA, contactB })
    } else if (varianceSignal) {
      flags.push({ fileLabel, reason: 'variance', dispersion: varDispersion })
    } else if (twoContactSignal) {
      flags.push({ fileLabel, reason: 'two-contact', dispersion: varDispersion, contactA, contactB })
    }
  }

  return flags
}
