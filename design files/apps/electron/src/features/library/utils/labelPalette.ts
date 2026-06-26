/**
 * Smart Labels — fixed Harbor-token color palette.
 *
 * Labels store a palette *token name* (not a free hex), so they stay legible in
 * light and dark themes. Each token maps to:
 *  - `dot`: a Tailwind background utility for the small chip dot / category dot
 *    (matches the existing `CaptureLabel.colorClass` convention in deriveCaptureLabels).
 *  - `swatch`: the same fill used for the Settings color-picker swatches.
 *
 * To add a color, add one entry here — nothing else in the app hardcodes colors.
 */
export interface LabelPaletteEntry {
  /** Stable token name persisted in config (AppConfig.labels.items[].color). */
  token: string
  /** Human label for the Settings picker tooltip / aria-label. */
  name: string
  /** Tailwind background utility used for chip dots and picker swatches. */
  dot: string
}

export const LABEL_PALETTE: LabelPaletteEntry[] = [
  { token: 'blue', name: 'Blue', dot: 'bg-primary' },
  { token: 'teal', name: 'Teal', dot: 'bg-accent-2' },
  { token: 'green', name: 'Green', dot: 'bg-success' },
  { token: 'amber', name: 'Amber', dot: 'bg-warning' },
  { token: 'violet', name: 'Violet', dot: 'bg-accent-strong-soft' },
  { token: 'coral', name: 'Coral', dot: 'bg-danger' },
  { token: 'slate', name: 'Slate', dot: 'bg-surface-sunken' }
]

/** Default token used when a label references an unknown/legacy color. */
export const DEFAULT_LABEL_COLOR = 'slate'

const PALETTE_BY_TOKEN: Record<string, LabelPaletteEntry> = Object.fromEntries(
  LABEL_PALETTE.map((entry) => [entry.token, entry])
)

/** Resolve a stored color token to its Tailwind dot class (falls back to slate). */
export function dotClassForToken(token?: string | null): string {
  if (token && PALETTE_BY_TOKEN[token]) return PALETTE_BY_TOKEN[token].dot
  return PALETTE_BY_TOKEN[DEFAULT_LABEL_COLOR].dot
}

/** True when a token is part of the fixed palette. */
export function isValidColorToken(token: string): boolean {
  return Object.prototype.hasOwnProperty.call(PALETTE_BY_TOKEN, token)
}
