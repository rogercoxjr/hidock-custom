/**
 * TemplateChip + SuggestNewBanner — Phase 3 (Task 13b) / Phase 4 (Task 14)
 *
 * TemplateChip: compact badge rendered near the summary when a transcript was
 * summarized with a named template.  Shows "Template: <name>" and, when available,
 * " · <pct>%" confidence.  An "instructions changed" hint appears when the live
 * template instructions hash differs from the hash stored on the transcript row.
 *
 * SuggestNewBanner: renders when the latest selector run has kind === 'suggest_new'.
 * Phase 4: the "Save" and "Edit & save" actions are now wired to acceptSuggestedTemplate.
 * "Save" accepts the suggestion as-is; "Edit & save" opens the edit dialog first.
 *
 * Precedence enforced by the caller (SourceReader): staleness > error > suggest-new.
 * This file owns only the chip + banner rendering.
 */

import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog'
import { toast } from '@/components/ui/toaster'
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
  /** Recording ID — required for acceptSuggestedTemplate IPC call. */
  recordingId: string
  /** Called after a successful accept + re-summarize, so the parent can refresh state. */
  onAccepted?: () => void
}

/**
 * Info banner rendered when the selector's latest run has kind === 'suggest_new'.
 * Phase 4: "Save" accepts the suggestion as-is; "Edit & save" opens a mini editor.
 * Both call window.electronAPI.summarizationTemplates.acceptSuggestedTemplate.
 */
export function SuggestNewBanner({ suggestedTemplate, recordingId, onAccepted }: SuggestNewBannerProps) {
  const suggestedName =
    typeof suggestedTemplate?.name === 'string' ? suggestedTemplate.name : 'a new template'
  const suggestedInstructions =
    typeof suggestedTemplate?.instructions === 'string' ? suggestedTemplate.instructions
    : typeof suggestedTemplate?.guidance === 'string' ? suggestedTemplate.guidance
    : ''
  const suggestedDescription =
    typeof suggestedTemplate?.description === 'string' ? suggestedTemplate.description : ''
  const suggestedTriggers =
    Array.isArray(suggestedTemplate?.exampleTriggers)
      ? (suggestedTemplate!.exampleTriggers as unknown[])
          .filter((t): t is string => typeof t === 'string')
          .join(', ')
      : ''

  const [busy, setBusy] = useState(false)

  // "Edit & save" dialog state
  const [editOpen, setEditOpen] = useState(false)
  const [editName, setEditName] = useState(suggestedName)
  const [editDescription, setEditDescription] = useState(suggestedDescription)
  const [editInstructions, setEditInstructions] = useState(suggestedInstructions)
  const [editTriggers, setEditTriggers] = useState(suggestedTriggers)

  const doAccept = async (edits?: {
    name?: string
    description?: string
    instructions?: string
    exampleTriggers?: string[]
  }) => {
    if (!recordingId || busy) return
    setBusy(true)
    try {
      const res = await window.electronAPI?.summarizationTemplates?.acceptSuggestedTemplate?.(
        recordingId,
        edits
      )
      if (res?.success) {
        toast.success('Template saved — re-summarizing…')
        setEditOpen(false)
        onAccepted?.()
      } else {
        const msg = res && !res.success ? (res as { error?: { message?: string } }).error?.message ?? 'Accept failed' : 'Accept failed'
        toast.error('Failed to accept template', msg)
      }
    } catch (err) {
      toast.error('Failed to accept template', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleSave = () => doAccept()

  const handleEditSave = () =>
    doAccept({
      name: editName.trim(),
      description: editDescription.trim() || undefined,
      instructions: editInstructions.trim(),
      exampleTriggers: editTriggers
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    })

  return (
    <>
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
        <div className="flex shrink-0 items-center gap-1.5">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setEditName(suggestedName)
                    setEditDescription(suggestedDescription)
                    setEditInstructions(suggestedInstructions)
                    setEditTriggers(suggestedTriggers)
                    setEditOpen(true)
                  }}
                  disabled={busy}
                  className="h-7 text-xs"
                  data-testid="suggest-new-edit-save"
                >
                  Edit & save
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">
                Review and edit before saving as a new template
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <Button
            variant="outline"
            size="sm"
            onClick={handleSave}
            disabled={busy}
            className="h-7 text-xs"
            data-testid="suggest-new-save"
          >
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>

      {/* Edit & save dialog */}
      <Dialog open={editOpen} onOpenChange={(open) => { if (!open) setEditOpen(false) }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit suggested template</DialogTitle>
            <DialogDescription>
              Review and adjust the suggested template before saving it. Once saved, this recording will be re-summarized with the new template.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div className="space-y-1">
              <label htmlFor="suggest-edit-name" className="text-sm font-medium text-ink">
                Name <span aria-hidden="true" className="text-destructive">*</span>
              </label>
              <Input
                id="suggest-edit-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="Template name"
                disabled={busy}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="suggest-edit-description" className="text-sm font-medium text-ink">Description</label>
              <Input
                id="suggest-edit-description"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                placeholder="Optional — when to use this template"
                disabled={busy}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="suggest-edit-instructions" className="text-sm font-medium text-ink">
                Instructions <span aria-hidden="true" className="text-destructive">*</span>
              </label>
              <textarea
                id="suggest-edit-instructions"
                className="flex min-h-[100px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm
                           placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1
                           focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 resize-y"
                value={editInstructions}
                onChange={(e) => setEditInstructions(e.target.value)}
                placeholder="Summarization instructions"
                disabled={busy}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="suggest-edit-triggers" className="text-sm font-medium text-ink">Example triggers</label>
              <Input
                id="suggest-edit-triggers"
                value={editTriggers}
                onChange={(e) => setEditTriggers(e.target.value)}
                placeholder="comma-separated keywords"
                disabled={busy}
              />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={busy}>Cancel</Button>
            </DialogClose>
            <Button
              onClick={handleEditSave}
              disabled={busy || !editName.trim() || !editInstructions.trim()}
              data-testid="suggest-new-edit-save-confirm"
            >
              {busy ? 'Saving…' : 'Save & re-summarize'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
