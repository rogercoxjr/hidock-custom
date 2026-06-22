/**
 * Summarization Templates manager (Settings → near Smart Labels).
 *
 * Lists DB-backed summarization templates and lets the user create, edit,
 * enable/disable, set-as-default, and delete them. Built-in templates (isBuiltin)
 * are protected — no delete, no enable/disable (service rejects those anyway, but
 * the UI withholds the controls as a first line of defense).
 *
 * All reads/writes go through window.electronAPI.summarizationTemplates.* (DB-backed IPC).
 * Each call branches on the Result envelope: { success, data } or { success: false, error }.
 *
 * Phase 3 note: a disabled "Test selection" button is present but inactive —
 * it will wire to previewSelection in Phase 4.
 */
import { useState, useEffect, useCallback } from 'react'
import { Plus, Trash2, Pencil, Star } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { toast } from '@/components/ui/toaster'

// --------------------------------------------------------------------------
// Types (mirrored from preload — no cross-boundary import)
// --------------------------------------------------------------------------

/** Failure envelope returned by the summarizationTemplates IPC namespace */
interface FailResult {
  success: false
  error: { code: string; message: string }
}
interface SummarizationTemplate {
  id: string
  name: string
  description: string
  instructions: string
  exampleTriggers: string[]
  isDefault: boolean
  isBuiltin: boolean
  enabled: boolean
  createdAt: string
  updatedAt: string
}

interface TemplateInput {
  name: string
  description?: string
  instructions: string
  exampleTriggers?: string[]
  isDefault?: boolean
  enabled?: boolean
}

// §8.1 client-side caps (service re-validates; this is first-line defense)
const MAX_NAME = 100
const MAX_DESCRIPTION = 500
const MAX_INSTRUCTIONS = 2000

// --------------------------------------------------------------------------
// Component
// --------------------------------------------------------------------------
export function SummarizationTemplatesCard() {
  const [templates, setTemplates] = useState<SummarizationTemplate[]>([])
  const [busy, setBusy] = useState(false)

  // Edit/create modal state
  const [modalOpen, setModalOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<SummarizationTemplate | null>(null)
  const [formName, setFormName] = useState('')
  const [formDescription, setFormDescription] = useState('')
  const [formInstructions, setFormInstructions] = useState('')
  const [formTriggers, setFormTriggers] = useState('') // comma-separated

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<SummarizationTemplate | null>(null)

  // ---- data loading -------------------------------------------------------
  const loadTemplates = useCallback(async () => {
    const res = await window.electronAPI.summarizationTemplates.list()
    if (res.success) {
      setTemplates(res.data)
    } else {
      toast.error('Failed to load templates', (res as FailResult).error?.message)
    }
  }, [])

  useEffect(() => {
    loadTemplates()
  }, [loadTemplates])

  // ---- modal helpers ------------------------------------------------------
  const openCreate = () => {
    setEditTarget(null)
    setFormName('')
    setFormDescription('')
    setFormInstructions('')
    setFormTriggers('')
    setModalOpen(true)
  }

  const openEdit = (t: SummarizationTemplate) => {
    setEditTarget(t)
    setFormName(t.name)
    setFormDescription(t.description ?? '')
    setFormInstructions(t.instructions)
    setFormTriggers(t.exampleTriggers?.join(', ') ?? '')
    setModalOpen(true)
  }

  // ---- CRUD handlers ------------------------------------------------------
  const handleSave = async () => {
    const trimmedName = formName.trim()
    const trimmedInstructions = formInstructions.trim()

    if (!trimmedName) {
      toast.error('Template name is required')
      return
    }
    if (!trimmedInstructions) {
      toast.error('Instructions are required')
      return
    }

    const payload: TemplateInput = {
      name: trimmedName.slice(0, MAX_NAME),
      description: formDescription.trim().slice(0, MAX_DESCRIPTION) || undefined,
      instructions: trimmedInstructions.slice(0, MAX_INSTRUCTIONS),
      exampleTriggers: formTriggers
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    }

    setBusy(true)
    try {
      if (editTarget) {
        const res = await window.electronAPI.summarizationTemplates.update(editTarget.id, payload)
        if (res.success) {
          toast.success('Template updated')
          setModalOpen(false)
          await loadTemplates()
        } else {
          toast.error('Failed to update template', (res as FailResult).error?.message)
        }
      } else {
        const res = await window.electronAPI.summarizationTemplates.create(payload)
        if (res.success) {
          toast.success('Template created')
          setModalOpen(false)
          await loadTemplates()
        } else {
          toast.error('Failed to create template', (res as FailResult).error?.message)
        }
      }
    } catch (err) {
      toast.error('Unexpected error', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleToggleEnabled = async (t: SummarizationTemplate) => {
    const nextEnabled = !t.enabled
    setBusy(true)
    try {
      const res = await window.electronAPI.summarizationTemplates.setEnabled(t.id, nextEnabled)
      if (res.success) {
        await loadTemplates()
      } else {
        toast.error('Failed to update template', (res as FailResult).error?.message)
      }
    } catch (err) {
      toast.error('Unexpected error', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleSetDefault = async (t: SummarizationTemplate) => {
    setBusy(true)
    try {
      const res = await window.electronAPI.summarizationTemplates.update(t.id, { isDefault: true })
      if (res.success) {
        toast.success(`"${t.name}" is now the default template`)
        await loadTemplates()
      } else {
        toast.error('Failed to set default', (res as FailResult).error?.message)
      }
    } catch (err) {
      toast.error('Unexpected error', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setBusy(true)
    try {
      const res = await window.electronAPI.summarizationTemplates.delete(deleteTarget.id)
      if (res.success) {
        toast.success(`"${deleteTarget.name}" deleted`)
        setDeleteTarget(null)
        await loadTemplates()
      } else {
        toast.error('Failed to delete template', (res as FailResult).error?.message)
        setDeleteTarget(null)
      }
    } catch (err) {
      toast.error('Unexpected error', err instanceof Error ? err.message : String(err))
      setDeleteTarget(null)
    } finally {
      setBusy(false)
    }
  }

  // ---- render -------------------------------------------------------------
  return (
    <>
      <Card className="border-border bg-surface shadow-sm">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="font-display text-[1.125rem] font-semibold tracking-[-0.01em] text-ink">
                Summarization Templates
              </CardTitle>
              <CardDescription className="text-ink-muted">
                Define prompt templates for AI meeting summaries. The default template is used
                automatically. Built-in templates cannot be removed or disabled.
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={openCreate} className="gap-1.5 shrink-0">
              <Plus className="h-4 w-4" />
              Add template
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2" data-testid="summarization-templates-list">
          {templates.length === 0 && (
            <p className="py-4 text-center text-sm text-ink-muted">No templates yet.</p>
          )}
          {templates.map((t) => (
            <div
              key={t.id}
              className="flex items-start gap-3 rounded-lg border border-border bg-surface-raised p-3"
            >
              {/* Text block */}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-medium text-ink">{t.name}</span>
                  {t.isBuiltin && (
                    <Badge variant="default" size="sm">
                      Built-in
                    </Badge>
                  )}
                  {t.isDefault && (
                    <Badge variant="success" size="sm">
                      Default
                    </Badge>
                  )}
                  {!t.enabled && (
                    <Badge variant="outline" size="sm">
                      Disabled
                    </Badge>
                  )}
                </div>
                {t.description && (
                  <p className="mt-0.5 text-xs text-ink-muted line-clamp-2">{t.description}</p>
                )}
              </div>

              {/* Actions */}
              <div className="flex shrink-0 items-center gap-1">
                {/* Enable/disable toggle — hidden for built-in */}
                {!t.isBuiltin && (
                  <Switch
                    checked={t.enabled}
                    onCheckedChange={() => handleToggleEnabled(t)}
                    disabled={busy}
                    aria-label={`Enable ${t.name}`}
                  />
                )}

                {/* Set as default — hidden for templates already default */}
                {!t.isDefault && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-ink-muted hover:text-primary"
                    onClick={() => handleSetDefault(t)}
                    disabled={busy}
                    aria-label={`Set as default`}
                    title="Set as default"
                  >
                    <Star className="h-4 w-4" />
                  </Button>
                )}

                {/* Edit */}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-ink-muted hover:text-ink"
                  onClick={() => openEdit(t)}
                  disabled={busy}
                  aria-label={`Edit ${t.name}`}
                  title={`Edit ${t.name}`}
                >
                  <Pencil className="h-4 w-4" />
                </Button>

                {/* Delete — hidden for built-in */}
                {!t.isBuiltin && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-ink-muted hover:text-destructive"
                    onClick={() => setDeleteTarget(t)}
                    disabled={busy}
                    aria-label={`Delete ${t.name}`}
                    title={`Delete ${t.name}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Create / Edit modal */}
      <Dialog open={modalOpen} onOpenChange={(open) => { if (!open) setModalOpen(false) }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editTarget ? 'Edit template' : 'New template'}</DialogTitle>
            <DialogDescription>
              {editTarget
                ? 'Update the template name, description, instructions, and trigger hints.'
                : 'Create a prompt template the AI will use when summarizing meetings.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-1">
            {/* Name */}
            <div className="space-y-1">
              <label htmlFor="tpl-name" className="text-sm font-medium text-ink">
                Template name <span aria-hidden="true" className="text-destructive">*</span>
              </label>
              <Input
                id="tpl-name"
                placeholder="e.g. Sales call recap"
                value={formName}
                onChange={(e) => setFormName(e.target.value.slice(0, MAX_NAME))}
                aria-label="Template name"
                aria-required="true"
              />
              <p className="text-right text-xs text-ink-muted">
                {formName.length}/{MAX_NAME}
              </p>
            </div>

            {/* Description */}
            <div className="space-y-1">
              <label htmlFor="tpl-description" className="text-sm font-medium text-ink">
                Description
              </label>
              <Input
                id="tpl-description"
                placeholder="Optional — when to use this template"
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value.slice(0, MAX_DESCRIPTION))}
                aria-label="Description"
              />
            </div>

            {/* Instructions */}
            <div className="space-y-1">
              <label htmlFor="tpl-instructions" className="text-sm font-medium text-ink">
                Instructions <span aria-hidden="true" className="text-destructive">*</span>
              </label>
              <textarea
                id="tpl-instructions"
                className="flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm
                           placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1
                           focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 resize-y"
                placeholder="Describe what the AI should focus on, format, length, etc."
                value={formInstructions}
                onChange={(e) => setFormInstructions(e.target.value.slice(0, MAX_INSTRUCTIONS))}
                aria-label="Instructions"
                aria-required="true"
              />
              <p className="text-right text-xs text-ink-muted">
                {formInstructions.length}/{MAX_INSTRUCTIONS}
              </p>
            </div>

            {/* Example triggers */}
            <div className="space-y-1">
              <label htmlFor="tpl-triggers" className="text-sm font-medium text-ink">
                Example triggers
              </label>
              <Input
                id="tpl-triggers"
                placeholder="sales, demo, retrospective (comma-separated)"
                value={formTriggers}
                onChange={(e) => setFormTriggers(e.target.value)}
                aria-label="Example triggers (comma-separated)"
              />
              <p className="text-xs text-ink-muted">
                Keywords that suggest this template — used by the auto-selector in future phases.
              </p>
            </div>

            {/* Phase 4 placeholder: test against a selection */}
            {/* The "Test selection" button activates in Phase 4 when previewSelection IPC is wired */}
            <Button variant="outline" size="sm" disabled className="w-full opacity-50">
              Test selection (available in a future update)
            </Button>
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button onClick={handleSave} disabled={busy}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete template?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{deleteTarget?.name}&rdquo; will be permanently removed. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
