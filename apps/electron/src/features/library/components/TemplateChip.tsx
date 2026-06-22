/**
 * TemplateChip + SuggestNewBanner — Phase 3 (Task 13b)
 *
 * TemplateChip: compact badge rendered near the summary when a transcript was
 * summarized with a named template.  Shows "Template: <name>" and, when available,
 * " · <pct>%" confidence.  An "instructions changed" hint appears when the live
 * template instructions hash differs from the hash stored on the transcript row.
 *
 * SuggestNewBanner: renders when the latest selector run has kind === 'suggest_new'.
 * Acceptance (creating the template + re-summarizing) is Phase-4 work; the
 * ACCEPT action is rendered DISABLED with a tooltip explaining this.
 *
 * Precedence enforced by the caller (SourceReader): staleness > error > suggest-new.
 * This file owns only the chip + banner rendering.
 */

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { AlertCircle, Lightbulb } from 'lucide-react'

// ---------------------------------------------------------------------------
// TemplateChip
// ---------------------------------------------------------------------------

export interface TemplateChipProps {
  /** Denormalized template name from the transcript row. Chip renders nothing when null/empty. */
  name: string | null | undefined
  /** Selector confidence (0–1). Shown as a percentage when present. */
  confidence?: number | null
  /** When true, shows an "instructions changed since this summary" hint. */
  instructionsChanged?: boolean
}

/**
 * Compact chip displayed near the summary section to show which template was used.
 * Renders nothing when `name` is absent.
 */
export function TemplateChip({ name, confidence, instructionsChanged }: TemplateChipProps) {
  if (!name) return null

  const pct = confidence != null ? Math.round(confidence * 100) : null
  const label = pct != null ? `Template: ${name} · ${pct}%` : `Template: ${name}`

  return (
    <TooltipProvider>
      <span className="inline-flex items-center gap-1.5">
        <Badge variant="accent" size="sm" data-testid="template-chip">
          {label}
        </Badge>
        {instructionsChanged && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="inline-flex cursor-default items-center"
                data-testid="template-instructions-changed"
                aria-label="Template instructions changed since this summary"
              >
                <AlertCircle className="h-3.5 w-3.5 text-warning" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">
              Template instructions changed since this summary was generated.
              Re-summarize to apply the updated template.
            </TooltipContent>
          </Tooltip>
        )}
      </span>
    </TooltipProvider>
  )
}

// ---------------------------------------------------------------------------
// SuggestNewBanner
// ---------------------------------------------------------------------------

export interface SuggestNewBannerProps {
  /** Suggested template payload from the run's suggestedTemplateJson field. */
  suggestedTemplate: Record<string, unknown> | null
}

/**
 * Info banner rendered when the selector's latest run has kind === 'suggest_new'.
 * Surfaces the suggestion read-only.  The ACCEPT button is disabled until Phase 4.
 */
export function SuggestNewBanner({ suggestedTemplate }: SuggestNewBannerProps) {
  const suggestedName =
    typeof suggestedTemplate?.name === 'string' ? suggestedTemplate.name : 'a new template'

  return (
    <div
      className="mb-3 flex items-start gap-2 rounded-md border border-[color-mix(in_oklch,var(--accent-2)_22%,transparent)] bg-accent-2-soft px-3 py-2 text-sm text-foreground"
      data-testid="suggest-new-banner"
      role="status"
      aria-label="No matching template — suggested new template"
    >
      <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-accent-2" aria-hidden />
      <div className="min-w-0 flex-1">
        <span className="font-medium">No matching template</span>
        <span className="text-ink-muted">
          {' '}— The selector suggests{' '}
          <span className="font-medium text-ink">"{suggestedName}"</span>.
        </span>
      </div>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            {/* span wrapper allows tooltip on a disabled button */}
            <span tabIndex={0} className="shrink-0">
              <Button
                variant="outline"
                size="sm"
                disabled
                aria-disabled="true"
                className="h-7 cursor-not-allowed text-xs"
              >
                Accept
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">
            Available after Phase 4 — template acceptance coming soon.
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  )
}
