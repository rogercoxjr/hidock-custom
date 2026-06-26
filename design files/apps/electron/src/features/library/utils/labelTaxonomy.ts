/**
 * Smart Labels — taxonomy helpers shared across Library filters, the source
 * reader category control, the capture-chip deriver, and the Settings manager.
 *
 * The taxonomy lives in AppConfig.labels.items (config.json). `id` is an immutable
 * slug that equals the stored knowledge_captures.category value; `name` is the
 * editable display label; `color` is a fixed Harbor palette token (labelPalette.ts).
 */
import type { LabelDefinition } from '@/types'
import { dotClassForToken } from './labelPalette'

/** The fallback label id orphaned rows are re-tagged to when a label is deleted. */
export const FALLBACK_LABEL_ID = 'other'

/** Resolve a label id to its display name; falls back to the raw id when unknown. */
export function labelName(items: LabelDefinition[], id?: string | null): string {
  if (!id) return ''
  const found = items.find((l) => l.id === id)
  return found ? found.name : id
}

/** Resolve a label id to its Tailwind dot color class (falls back to the slate token). */
export function labelColorClass(items: LabelDefinition[], id?: string | null): string {
  const found = id ? items.find((l) => l.id === id) : undefined
  return dotClassForToken(found?.color)
}

/**
 * Slugify a display name into a candidate label id. Lowercase, keep `:` (so '1:1'
 * round-trips), collapse runs of other non-alphanumerics into single hyphens.
 */
export function slugifyLabelId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export interface AddLabelValidation {
  ok: boolean
  id?: string
  error?: string
}

/**
 * Validate a proposed new label name against the existing taxonomy. Returns the
 * slugified id on success, or a human-readable error (empty / duplicate id / name).
 */
export function validateNewLabel(items: LabelDefinition[], rawName: string): AddLabelValidation {
  const name = rawName.trim()
  if (!name) return { ok: false, error: 'Name cannot be empty' }

  const id = slugifyLabelId(name)
  if (!id) return { ok: false, error: 'Name must contain letters or numbers' }

  if (items.some((l) => l.id === id)) {
    return { ok: false, error: 'A label with this name already exists' }
  }
  if (items.some((l) => l.name.trim().toLowerCase() === name.toLowerCase())) {
    return { ok: false, error: 'A label with this name already exists' }
  }
  return { ok: true, id }
}
