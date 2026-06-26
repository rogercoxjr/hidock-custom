import type { CaptureLabel } from '../types/captureMeta'
import type { LabelDefinition } from '@/types'
import { dotClassForToken } from './labelPalette'

/** Max uncolored topic chips appended after the category chip. */
const MAX_TOPIC_CHIPS = 2

/** Parse a transcript `topics` value (JSON string of string[], or an array). */
function parseTopics(topics?: string | string[] | null): string[] {
  if (!topics) return []
  if (Array.isArray(topics)) return topics.filter((t): t is string => typeof t === 'string')
  try {
    const parsed = JSON.parse(topics)
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}

/**
 * Derive capture labels: the recording's category (colored + named from the user
 * taxonomy) plus up to MAX_TOPIC_CHIPS uncolored topic chips from the transcript's
 * `topics`.
 *
 * `taxonomy` is AppConfig.labels.items. The category chip shows the label's display
 * `name` (not the raw id) and its color comes from the label's Harbor palette token.
 * An unknown/legacy category falls back to its raw id + the slate dot color. Topic
 * chips stay uncolored.
 */
export function deriveCaptureLabels(
  category?: string | null,
  topics?: string | string[] | null,
  taxonomy?: LabelDefinition[]
): CaptureLabel[] {
  const labels: CaptureLabel[] = []
  if (category) {
    const def = taxonomy?.find((l) => l.id === category)
    labels.push({
      text: def ? def.name : category,
      kind: 'category',
      colorClass: dotClassForToken(def?.color)
    })
  }
  for (const topic of parseTopics(topics).slice(0, MAX_TOPIC_CHIPS)) {
    const text = topic.trim()
    if (text) labels.push({ text, kind: 'topic' }) // no colorClass -> uncolored chip
  }
  return labels
}

/**
 * Stable primitive key from a labels array — safe to use in memo comparators
 * without array allocation per comparison.
 */
export function buildLabelsKey(labels: CaptureLabel[]): string {
  return labels.map((l) => `${l.kind}:${l.text}`).join('|')
}
