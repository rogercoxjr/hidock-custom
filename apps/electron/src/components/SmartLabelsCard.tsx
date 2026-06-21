/**
 * Smart Labels manager (Settings → near Appearance).
 *
 * v1 manual colored taxonomy. Each label row: a color swatch (→ palette popover),
 * an editable name Input, and a remove button (hidden for built-ins). An add-label
 * row slugifies the name into an immutable id and rejects duplicates.
 *
 * All writes go through useConfigStore.updateConfig('labels', …) — no new IPC.
 * Delete reconciles orphaned captures to 'other' BEFORE removing the label, and
 * resets the active Library category filter if it pointed at the deleted label.
 */
import { useState } from 'react'
import { Trash2, Plus } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { toast } from '@/components/ui/toaster'
import { useConfigStore } from '@/store/domain/useConfigStore'
import { useLibraryStore } from '@/store/useLibraryStore'
import type { LabelDefinition } from '@/types'
import { LABEL_PALETTE, dotClassForToken } from '@/features/library/utils/labelPalette'
import { validateNewLabel, FALLBACK_LABEL_ID } from '@/features/library/utils/labelTaxonomy'

/**
 * Re-tag every non-deleted capture whose category == `fromId` to FALLBACK_LABEL_ID,
 * via the existing per-id knowledge:update IPC (no new bulk IPC). Paginates getAll
 * so large libraries are fully covered.
 */
async function reconcileDeletedLabel(fromId: string): Promise<void> {
  const api = window.electronAPI
  if (!api?.knowledge?.getAll || !api?.knowledge?.update) return
  const PAGE = 100
  // getAll filters by category and orders stably; because we re-tag each fetched row
  // to 'other', the matching set shrinks — so always page from offset 0 until empty.
  // (Guard with a max-iteration cap to avoid any pathological loop.)
  for (let guard = 0; guard < 1000; guard++) {
    const rows = await api.knowledge.getAll({ category: fromId, limit: PAGE, offset: 0 })
    if (!rows || rows.length === 0) break
    for (const row of rows) {
      await api.knowledge.update(row.id, { category: FALLBACK_LABEL_ID })
    }
    if (rows.length < PAGE) break
  }
}

export function SmartLabelsCard() {
  const config = useConfigStore((s) => s.config)
  const updateConfig = useConfigStore((s) => s.updateConfig)
  const categoryFilter = useLibraryStore((s) => s.categoryFilter)
  const setCategoryFilter = useLibraryStore((s) => s.setCategoryFilter)

  const items: LabelDefinition[] = config?.labels?.items ?? []

  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)

  const persist = async (nextItems: LabelDefinition[]) => {
    await updateConfig('labels', { items: nextItems })
  }

  const handleRename = async (id: string, name: string) => {
    // id is immutable — only the display name changes. No row rewrite needed.
    const next = items.map((l) => (l.id === id ? { ...l, name } : l))
    try {
      await persist(next)
    } catch {
      toast.error('Failed to rename label')
    }
  }

  const handleRecolor = async (id: string, color: string) => {
    const next = items.map((l) => (l.id === id ? { ...l, color } : l))
    try {
      await persist(next)
    } catch {
      toast.error('Failed to update label color')
    }
  }

  const handleDelete = async (label: LabelDefinition) => {
    if (label.builtin) return // built-ins cannot be hard-deleted
    setBusy(true)
    try {
      // 1. Re-tag orphaned captures to 'other' BEFORE removing the label from config.
      await reconcileDeletedLabel(label.id)
      // 2. Remove from the taxonomy.
      await persist(items.filter((l) => l.id !== label.id))
      // 3. If the deleted label was the active Library filter, reset it.
      if (categoryFilter === label.id) setCategoryFilter(null)
      toast.success('Label deleted', `Recordings re-tagged to "Other".`)
    } catch {
      toast.error('Failed to delete label')
    } finally {
      setBusy(false)
    }
  }

  const handleAdd = async () => {
    const result = validateNewLabel(items, newName)
    if (!result.ok || !result.id) {
      toast.error(result.error ?? 'Invalid label name')
      return
    }
    setBusy(true)
    try {
      await persist([...items, { id: result.id, name: newName.trim(), color: LABEL_PALETTE[0].token }])
      setNewName('')
    } catch {
      toast.error('Failed to add label')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="border-border bg-surface shadow-sm">
      <CardHeader>
        <CardTitle className="font-display text-[1.125rem] font-semibold tracking-[-0.01em] text-ink">
          Smart Labels
        </CardTitle>
        <CardDescription className="text-ink-muted">
          Name and color the categories you use to organize recordings. Built-in labels can be
          renamed or recolored but not removed.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Existing label rows */}
        <div className="space-y-2" data-testid="smart-labels-list">
          {items.map((label) => (
            <div key={label.id} className="flex items-center gap-2">
              {/* Color swatch → palette popover */}
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface hover:border-border-strong"
                    aria-label={`Change color for ${label.name}`}
                  >
                    <span className={`h-3.5 w-3.5 rounded-full ${dotClassForToken(label.color)}`} />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-2" align="start">
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label="Label color">
                    {LABEL_PALETTE.map((entry) => (
                      <button
                        key={entry.token}
                        type="button"
                        onClick={() => handleRecolor(label.id, entry.token)}
                        className={`flex h-7 w-7 items-center justify-center rounded-md border transition-colors ${
                          label.color === entry.token ? 'border-border-strong' : 'border-border hover:border-border-strong'
                        }`}
                        aria-label={entry.name}
                        aria-pressed={label.color === entry.token}
                        title={entry.name}
                      >
                        <span className={`h-3.5 w-3.5 rounded-full ${entry.dot}`} />
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>

              {/* Editable name */}
              <Input
                value={label.name}
                onChange={(e) => handleRename(label.id, e.target.value)}
                className="h-8 flex-1"
                aria-label={`Name for label ${label.id}`}
              />

              {/* Remove (built-ins hide this) */}
              {label.builtin ? (
                <span className="w-8 shrink-0" aria-hidden="true" />
              ) : (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 text-ink-muted hover:text-destructive"
                  onClick={() => handleDelete(label)}
                  disabled={busy}
                  aria-label={`Remove ${label.name}`}
                  title={`Remove ${label.name}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          ))}
        </div>

        {/* Add label */}
        <div className="flex items-center gap-2 border-t border-border pt-3">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAdd() }}
            placeholder="Add a label…"
            className="h-8 flex-1"
            aria-label="New label name"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={handleAdd}
            disabled={busy || newName.trim().length === 0}
            className="gap-1.5"
          >
            <Plus className="h-4 w-4" />
            Add
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
