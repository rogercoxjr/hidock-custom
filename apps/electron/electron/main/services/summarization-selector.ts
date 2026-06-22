/**
 * summarization-selector.ts
 *
 * Pure, deterministic, LLM-free selection logic for summarization templates.
 * No side-effects: no DB, no IPC, no LLM calls.
 *
 * Exported:
 *   decideSelection(parsed, userTemplates, userDefaultId) → TemplateSelectionResult
 *   buildExcerpt(fullText) → string
 */

import type { SummarizationTemplate } from './summarization-templates'

// ── Band constants (§5.4) ──────────────────────────────────────────────────
const AUTO_CONF   = 0.72  // confidence threshold for auto-select
const AUTO_MARGIN = 0.12  // minimum margin (conf - runnerUpConf) for auto-select
const LOW_CONF    = 0.50  // below this → low band

// ── Excerpt budget ─────────────────────────────────────────────────────────
const EXCERPT_MAX_CHARS = 8000  // ~1.5–2k tokens; short transcripts returned whole

// ── Types ──────────────────────────────────────────────────────────────────

export interface SuggestedTemplateShape {
  name: string
  description: string
  instructions: string
  exampleTriggers: string[]
}

/** Output from the LLM selection call (or a mock/stub for testing). */
export interface ParsedSelection {
  templateId?: string
  confidence: number
  runnerUpConfidence?: number
  reason?: string
  suggestedTemplate?: SuggestedTemplateShape
}

export type SelectionKind = 'selected' | 'suggest_new' | 'use_default' | 'manual'

export interface TemplateSelectionResult {
  kind: SelectionKind
  templateId?: string
  /** Clamped to [0, 1]. */
  confidence: number
  reason: string
  suggestedTemplate?: SuggestedTemplateShape
}

// ── decideSelection ────────────────────────────────────────────────────────

/**
 * Applies the band logic from spec §5.4.
 *
 * Band rules (evaluated in order):
 *  1. Unknown templateId (not in userTemplates)      → use_default
 *  2. conf ≥ AUTO_CONF AND margin ≥ AUTO_MARGIN      → selected
 *  3. conf ≥ LOW_CONF (0.50–0.71, or tight margin)  → use_default (advisory)
 *  4. conf < LOW_CONF + suggestedTemplate present    → suggest_new
 *  5. conf < LOW_CONF, no suggestion                 → use_default
 *
 * Confidence is clamped to [0, 1] before band evaluation.
 * margin = confidence - (runnerUpConfidence ?? 0); never NaN.
 */
export function decideSelection(
  parsed: ParsedSelection,
  userTemplates: SummarizationTemplate[],
  _userDefaultId: string | null,
): TemplateSelectionResult {
  // Clamp confidence first — NaN becomes 0 via Math.max/min chain
  const rawConf = typeof parsed.confidence === 'number' && !isNaN(parsed.confidence)
    ? parsed.confidence
    : 0
  const conf = Math.min(1, Math.max(0, rawConf))

  const runnerUp = typeof parsed.runnerUpConfidence === 'number' && !isNaN(parsed.runnerUpConfidence)
    ? parsed.runnerUpConfidence
    : 0

  const margin = conf - runnerUp

  // Rule 1: unknown / missing templateId
  const knownTemplate = parsed.templateId
    ? userTemplates.find((t) => t.id === parsed.templateId)
    : undefined

  if (parsed.templateId && !knownTemplate) {
    return {
      kind: 'use_default',
      confidence: conf,
      reason: `Template id "${parsed.templateId}" not found in user templates`,
    }
  }

  // Rule 2: high-confidence auto-select
  if (conf >= AUTO_CONF && margin >= AUTO_MARGIN && knownTemplate) {
    return {
      kind: 'selected',
      templateId: knownTemplate.id,
      confidence: conf,
      reason: parsed.reason ?? `Auto-selected "${knownTemplate.name}" (conf=${conf.toFixed(2)}, margin=${margin.toFixed(2)})`,
    }
  }

  // Rule 3: mid-band — advisory use_default (confidence in range but margin too small,
  //          or confidence 0.50–0.71 regardless of margin)
  if (conf >= LOW_CONF) {
    return {
      kind: 'use_default',
      confidence: conf,
      reason: parsed.reason ?? `Confidence (${conf.toFixed(2)}) or margin (${margin.toFixed(2)}) below auto-select threshold`,
    }
  }

  // Rule 4: low-band with a suggested template → suggest_new
  if (parsed.suggestedTemplate) {
    return {
      kind: 'suggest_new',
      confidence: conf,
      reason: parsed.reason ?? `Low confidence (${conf.toFixed(2)}); a new template may fit better`,
      suggestedTemplate: parsed.suggestedTemplate,
    }
  }

  // Rule 5: low-band, no suggestion → use_default
  return {
    kind: 'use_default',
    confidence: conf,
    reason: parsed.reason ?? `Low confidence (${conf.toFixed(2)}); using default template`,
  }
}

// ── buildExcerpt ───────────────────────────────────────────────────────────

/**
 * Returns a token-budgeted excerpt of the transcript.
 *
 * If fullText.length ≤ EXCERPT_MAX_CHARS → return fullText verbatim.
 * Otherwise, split the budget evenly across begin, middle, and end:
 *   - segLen = Math.floor(EXCERPT_MAX_CHARS / 3)
 *   - begin  = fullText.slice(0, segLen)
 *   - middle = fullText.slice(mid - half, mid + half)  where mid = len/2, half = segLen/2
 *   - end    = fullText.slice(len - segLen)
 * Joined with "\n[...]\n" separators.
 *
 * The 3 segments are derived from the real text length so they always
 * represent beginning, centre, and end of the actual transcript.
 */
export function buildExcerpt(fullText: string): string {
  if (fullText.length <= EXCERPT_MAX_CHARS) {
    return fullText
  }

  const len     = fullText.length
  const segLen  = Math.floor(EXCERPT_MAX_CHARS / 3)  // chars per segment
  const half    = Math.floor(segLen / 2)
  const mid     = Math.floor(len / 2)

  const begin  = fullText.slice(0, segLen)
  const middle = fullText.slice(Math.max(0, mid - half), mid + half)
  const end    = fullText.slice(Math.max(0, len - segLen))

  return `${begin}\n[...]\n${middle}\n[...]\n${end}`
}
