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

/**
 * Derive capture labels from a recording's category field.
 * Slice 1: category only. Slice 2 will add uncolored topic chips.
 */
export function deriveCaptureLabels(category?: string | null): CaptureLabel[] {
  if (!category) return []
  return [
    {
      text: category,
      kind: 'category',
      colorClass: CATEGORY_COLOR[category],
    },
  ]
}

/**
 * Stable primitive key from a labels array — safe to use in memo comparators
 * without array allocation per comparison.
 */
export function buildLabelsKey(labels: CaptureLabel[]): string {
  return labels.map((l) => `${l.kind}:${l.text}`).join('|')
}
