import type { CaptureLabel } from '../types/captureMeta'

/** Fixed color tokens for the 6 known SourceCategory values. */
const CATEGORY_COLOR: Record<string, string> = {
  meeting: 'bg-primary',
  interview: 'bg-accent-2',
  '1:1': 'bg-success',
  brainstorm: 'bg-warning',
  note: 'bg-accent-strong-soft',
  other: 'bg-surface-sunken',
}

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
 * Derive capture labels: the recording's category (colored) plus up to
 * MAX_TOPIC_CHIPS uncolored topic chips from the transcript's `topics`.
 */
export function deriveCaptureLabels(
  category?: string | null,
  topics?: string | string[] | null
): CaptureLabel[] {
  const labels: CaptureLabel[] = []
  if (category) {
    labels.push({ text: category, kind: 'category', colorClass: CATEGORY_COLOR[category] })
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
