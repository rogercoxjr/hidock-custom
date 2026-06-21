# Responsive Layout — Master/Detail + Content-First Rows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the always-mounted fixed-column layout in the Library with a content-width–driven master/detail state machine, and redesign SourceRow to be content-first with an overflow action menu.

**Architecture:** TriPaneLayout gains a `ResizeObserver` on its container to derive `contentNarrow` (W < 1100px). Selection state from `useLibraryStore` drives whether the detail pane mounts at all. SourceRow keeps all existing action handlers but exposes only checkbox + play button as always-visible controls; all secondary actions move into a `DropdownMenu` triggered by a hover-reveal kebab.

**Tech Stack:** React 18, TypeScript, Tailwind CSS, Zustand (`useLibraryStore`), Radix `@radix-ui/react-dropdown-menu` (already installed), Lucide icons, Harbor tokens.

## Global Constraints

- `npm run typecheck:web` must pass clean after changes.
- `npm run test:run` must stay green; update tests for intentional changes only — never weaken a test to pass.
- `npm run build` must succeed.
- Do NOT change IPC, store shapes beyond tiny UI state, or existing handler logic.
- Preserve existing assistant drawer wiring (`assistantOpen` / `setAssistantOpen`).
- Use Harbor tokens: `bg-surface`, `border-border`, `text-ink`, `text-ink-muted`, `shadow-xl`, `rounded-md`, `rounded-lg`, etc.
- ResizeObserver unavailable in test env → default to wide (showDetail rail/detail layout). Guard with `typeof ResizeObserver !== 'undefined'`.
- Line length: 120 characters max.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `apps/electron/src/features/library/components/TriPaneLayout.tsx` | Modify | Content-width state machine (ResizeObserver), master/detail layout, back bar, preserve assistant drawer |
| `apps/electron/src/features/library/components/SourceRow.tsx` | Modify | Content-first rows, overflow DropdownMenu for secondary actions, status Badge pill |
| `apps/electron/src/test/setup.ts` | Modify | Add global `ResizeObserver` mock so jsdom tests don't crash |
| `apps/electron/src/pages/__tests__/Library.test.tsx` | Modify | Update mock of `useLibraryStore` to expose missing fields; fix any assertions broken by the new layout |

---

## Task 1: Mock ResizeObserver in the test setup

The jsdom test environment does not define `ResizeObserver`. TriPaneLayout will call `new ResizeObserver(…)` so tests crash unless we mock it globally first.

**Files:**
- Modify: `apps/electron/src/test/setup.ts`

**Interfaces:**
- Produces: `global.ResizeObserver` stub that satisfies `new ResizeObserver(cb); ro.observe(el); ro.disconnect()`.

- [ ] **Step 1: Read the file**

Read `apps/electron/src/test/setup.ts` to see the current content. (Already done during planning — we add below the existing matchMedia mock.)

- [ ] **Step 2: Add ResizeObserver mock**

In `apps/electron/src/test/setup.ts`, inside the `if (typeof window !== 'undefined')` block, **after** the `matchMedia` mock, add:

```typescript
  // Mock ResizeObserver (jsdom does not implement it)
  global.ResizeObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  }))
```

- [ ] **Step 3: Run tests to confirm no new failures**

```bash
cd apps/electron && npm run test:run -- --reporter=verbose 2>&1 | tail -20
```

Expected: all previously passing tests still pass; no `ResizeObserver is not defined` errors.

- [ ] **Step 4: Commit**

```bash
cd apps/electron && git add src/test/setup.ts && git commit -m "test: mock ResizeObserver in jsdom setup to support TriPaneLayout"
```

---

## Task 2: Replace TriPaneLayout with content-width state machine

Replace the viewport media-query (isMobile/isTablet) model with a `ResizeObserver` on the layout container measuring **content width**. Drive all three layout states from `selectedSourceId` + `contentNarrow`. Preserve the existing assistant drawer overlay exactly as it is.

**Files:**
- Modify: `apps/electron/src/features/library/components/TriPaneLayout.tsx`

**Interfaces:**
- Consumes from store: `selectedSourceId: string | null`, `setSelectedSourceId: (id: string | null) => void`, `assistantOpen: boolean`, `setAssistantOpen: (open: boolean) => void`  
- Props unchanged: `{ leftPanel, centerPanel, rightPanel }` — `rightPanel` still passed and used by the assistant drawer.
- Derived booleans (local): `showDetail = selectedSourceId != null`, `contentNarrow` (from ResizeObserver), `listIsRail = showDetail && !contentNarrow`, `listIsHidden = showDetail && contentNarrow`.

- [ ] **Step 1: Rewrite TriPaneLayout.tsx**

Replace the entire file content with the implementation below. Key points:
- `containerRef` on the outer `div` is observed by `ResizeObserver`.
- Default wide (rail+detail) when `ResizeObserver` is absent (test env guard).
- Three layout states rendered from derived booleans, NO `ResizablePanelGroup`.
- Back bar (thin `<header>`) renders above `centerPanel` when `listIsHidden`.
- Esc handler closes assistant AND deselects when detail is shown.
- Transitions: `motion-safe:transition-[width,transform]` + `motion-safe:duration-200` on list rail; drawer keeps its existing transition.
- `assistantOpen` wiring is preserved intact.

```typescript
/**
 * TriPaneLayout Component
 *
 * Content-width-driven master/detail layout for the Library page.
 * Measures the container with ResizeObserver; breakpoint: 1100px.
 *
 * Layout states (W = content width, selectedId from useLibraryStore):
 *  selectedId == null               → list fills full width; detail NOT mounted
 *  selectedId != null, W ≥ 1100px   → list fixed rail 300px; detail fills rest
 *  selectedId != null, W < 1100px   → list hidden; detail full-bleed + back bar
 *
 * Panels:
 *  leftPanel  – capture list (full-width or rail or hidden)
 *  centerPanel – source detail (mounted ONLY when selectedId != null)
 *  rightPanel  – AI assistant (overlay drawer; opened via assistantOpen store flag)
 */

import { useRef, useEffect, useState, useCallback } from 'react'
import { ChevronLeft } from 'lucide-react'
import { useLibraryStore } from '@/store/useLibraryStore'

const NARROW_BREAKPOINT = 1100 // px of content width

interface TriPaneLayoutProps {
  leftPanel: React.ReactNode
  centerPanel: React.ReactNode
  rightPanel: React.ReactNode
}

export function TriPaneLayout({ leftPanel, centerPanel, rightPanel }: TriPaneLayoutProps) {
  const selectedSourceId = useLibraryStore((s) => s.selectedSourceId)
  const setSelectedSourceId = useLibraryStore((s) => s.setSelectedSourceId)
  const assistantOpen = useLibraryStore((s) => s.assistantOpen)
  const setAssistantOpen = useLibraryStore((s) => s.setAssistantOpen)

  // Default to wide (false = not narrow) so test env without ResizeObserver stays stable
  const [contentNarrow, setContentNarrow] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Observe container width — guard for test environments without ResizeObserver
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? el.offsetWidth
      setContentNarrow(width < NARROW_BREAKPOINT)
    })
    ro.observe(el)
    // Run once synchronously on mount
    setContentNarrow(el.offsetWidth < NARROW_BREAKPOINT)
    return () => ro.disconnect()
  }, [])

  const showDetail = selectedSourceId != null
  const listIsRail = showDetail && !contentNarrow
  const listIsHidden = showDetail && contentNarrow

  const handleDeselect = useCallback(() => {
    setSelectedSourceId(null)
  }, [setSelectedSourceId])

  // Esc: close assistant drawer first; if already closed + detail open, deselect
  useEffect(() => {
    if (!assistantOpen && !showDetail) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (assistantOpen) {
        setAssistantOpen(false)
      } else if (showDetail) {
        handleDeselect()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [assistantOpen, showDetail, setAssistantOpen, handleDeselect])

  return (
    <div ref={containerRef} className="relative flex h-full overflow-hidden">
      {/* List panel — full width | fixed rail | hidden */}
      <div
        aria-label="Recording list"
        role="region"
        className={[
          'h-full overflow-auto flex-shrink-0',
          'motion-safe:transition-[width,opacity] motion-safe:duration-200 motion-safe:ease-out',
          listIsHidden
            ? 'w-0 opacity-0 pointer-events-none overflow-hidden'
            : listIsRail
              ? 'w-[300px] border-r border-border'
              : 'flex-1',
        ].join(' ')}
        aria-hidden={listIsHidden}
      >
        {listPanel}
      </div>

      {/* Detail panel — only mounted when something is selected */}
      {showDetail && (
        <div className="flex min-w-0 flex-1 flex-col h-full overflow-hidden">
          {/* Back bar — only shown when list is hidden (narrow + selected) */}
          {listIsHidden && (
            <div className="flex shrink-0 items-center border-b border-border bg-surface px-3 py-2">
              <button
                onClick={handleDeselect}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-sm text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
                aria-label="Back to library list"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                Library
              </button>
            </div>
          )}
          <div role="region" aria-label="Recording content viewer" className="min-h-0 flex-1 overflow-hidden">
            {centerPanel}
          </div>
        </div>
      )}

      {/* AI Assistant: overlay drawer — default closed, opened via store */}
      {assistantOpen && (
        <>
          <div
            className="absolute inset-0 z-20 bg-[var(--overlay)] motion-safe:transition-opacity motion-safe:duration-300"
            onClick={() => setAssistantOpen(false)}
            aria-hidden="true"
          />
          <div
            role="region"
            aria-label="AI Assistant"
            className="absolute inset-y-0 right-0 z-30 flex w-[380px] max-w-[86%] flex-col border-l border-border bg-surface shadow-xl motion-safe:transition-transform motion-safe:duration-300"
          >
            <div className="flex items-center justify-between border-b border-border bg-surface-sunken p-3">
              <h3 className="font-semibold text-ink">AI Assistant</h3>
              <button
                onClick={() => setAssistantOpen(false)}
                className="rounded-md p-1.5 transition-colors hover:bg-surface-hover"
                aria-label="Close AI assistant panel"
              >
                <svg className="h-4 w-4 text-ink-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">{rightPanel}</div>
          </div>
        </>
      )}

      {/* Floating toggle to summon the Assistant */}
      {!assistantOpen && (
        <button
          onClick={() => setAssistantOpen(true)}
          className="absolute bottom-6 right-6 z-20 flex items-center gap-2 rounded-full bg-primary px-4 py-3 text-primary-foreground shadow-lg transition-colors hover:bg-primary/90"
          aria-label="Open AI assistant panel"
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-sm font-medium">Assistant</span>
        </button>
      )}
    </div>
  )
}
```

**NOTE:** There is a bug in the template above — the list panel renders `{listPanel}` but the prop is named `leftPanel`. Fix it to `{leftPanel}` in the actual file.

- [ ] **Step 2: Run typecheck**

```bash
cd apps/electron && npm run typecheck:web 2>&1 | grep -E "error TS|Found [0-9]+ error"
```

Expected: `Found 0 errors`.

- [ ] **Step 3: Run tests**

```bash
cd apps/electron && npm run test:run 2>&1 | tail -30
```

Expected: all passing.

- [ ] **Step 4: Commit**

```bash
cd apps/electron && git add src/features/library/components/TriPaneLayout.tsx && git commit -m "feat(library): content-width master/detail layout via ResizeObserver"
```

---

## Task 3: Update Library.tsx — remove placeholder reliance, wire Esc deselect

`Library.tsx` currently always passes `centerPanel` with `SourceReader` (which handles `recording == null` as a "no recording selected" placeholder). We need to gate this so `TriPaneLayout` only receives a `centerPanel` when `selectedSourceId != null`. Also wire clicking the already-selected row to deselect.

**Files:**
- Modify: `apps/electron/src/pages/Library.tsx`

**Interfaces:**
- Consumes: `selectedSourceId` from `useLibraryStore` (already in scope).
- The `SourceReader` component still receives `recording={selectedRecording ?? null}` — no change to SourceReader itself.
- `TriPaneLayout` props are unchanged; we just pass `null`-safe JSX.

- [ ] **Step 1: Add click-to-deselect to handleRowClick**

Find `handleRowClick` in `Library.tsx`. The click currently calls `selectSingle(recording.id)`. Add logic: if `selectedSourceId === recording.id`, call `setSelectedSourceId(null)` instead.

Current code (around line 770):
```typescript
const handleRowClick = useCallback((recording: UnifiedRecording) => {
  audioControls.stop()
  selectSingle(recording.id)
  // ...
}, [selectSingle, audioControls])
```

Updated:
```typescript
const handleRowClick = useCallback((recording: UnifiedRecording) => {
  // Clicking the already-selected row deselects it (closes detail pane)
  if (selectedSourceId === recording.id) {
    setSelectedSourceId(null)
    return
  }
  audioControls.stop()
  selectSingle(recording.id)

  const { waveformLoadedForId } = useUIStore.getState()
  if (hasLocalPath(recording) && waveformLoadedForId !== recording.id) {
    audioControls.loadWaveformOnly(recording.id, recording.localPath)
  }
}, [selectedSourceId, setSelectedSourceId, selectSingle, audioControls])
```

- [ ] **Step 2: Gate centerPanel on selectedRecording**

In the `TriPaneLayout` usage (around line 947), the `centerPanel` prop currently always renders `<SourceReader …>`. Wrap it so it only renders when `selectedRecording != null`:

```typescript
centerPanel={
  selectedRecording
    ? (
      <SourceReader
        recording={selectedRecording}
        transcript={selectedTranscript}
        // ... all existing props unchanged ...
      />
    )
    : null
}
```

`TriPaneLayout` already gates mounting on `showDetail = selectedSourceId != null`, so passing `null` for `centerPanel` is fine — it will never render.

- [ ] **Step 3: Run typecheck + tests**

```bash
cd apps/electron && npm run typecheck:web 2>&1 | grep -E "error TS|Found [0-9]+ error"
cd apps/electron && npm run test:run 2>&1 | tail -30
```

Expected: no errors, tests pass.

- [ ] **Step 4: Commit**

```bash
cd apps/electron && git add src/pages/Library.tsx && git commit -m "feat(library): gate detail panel on selection; click-to-deselect active row"
```

---

## Task 4: Content-first SourceRow with overflow action menu

Replace the always-visible icon row with a content-first layout: primary title, secondary meta line (date · duration · status pill), checkbox (left), play button (right), and a hover-reveal overflow `DropdownMenu` for all secondary actions.

**Files:**
- Modify: `apps/electron/src/features/library/components/SourceRow.tsx`

**Interfaces:**
- Props interface unchanged — all existing handlers preserved, just moved to DropdownMenu items.
- Status pill: use `<Badge>` with variants keyed by `recording.location`.
- Overflow menu trigger: `MoreHorizontal` icon from lucide-react, `opacity-0 group-hover:opacity-100 focus-within:opacity-100` for hover-reveal.

- [ ] **Step 1: Rewrite SourceRow.tsx**

Replace the file with the implementation below. Key design changes:
1. Row root gets `group` class for hover reveal.
2. Left area: checkbox + icon tile + content (title + secondary line with date · duration + status Badge).
3. Right area: hidden overflow menu trigger (revealed on group-hover) + always-visible play/stop button.
4. Overflow `DropdownMenu` contains: Transcribe, Download (if applicable), Ask Assistant, Generate Output, separator, Delete.
5. Status pill: `Badge` component with variant matching location (`device-only` → `warning`, `local-only` → `primary`, `both` → `success`).
6. Error indicator stays as a visible `AlertCircle` (it signals an actionable problem, not a secondary action).
7. Insight count badge unchanged.
8. `isDownloading` in-progress display stays as an inline pill inside the overflow trigger area.
9. Custom memo comparison function updated to include `isDownloading` and `downloadProgress`.

```typescript
import { memo, useState } from 'react'
import {
  Play, Square, AlertCircle, Download, Trash2, Wand2,
  Mic, FileText, RefreshCw, MoreHorizontal
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { formatDate, formatDuration } from '@/lib/utils'
import { Meeting, Transcript, parseJsonArray } from '@/types'
import { UnifiedRecording, hasLocalPath } from '@/types/unified-recording'
import { StatusIcon } from './StatusIcon'
import { useLibraryStore } from '@/store/useLibraryStore'
import { getDisplayTitle } from '@/features/library/utils/getDisplayTitle'
import { highlightText } from '@/features/library/utils/highlightText'

function insightCount(transcript?: Transcript): number {
  if (!transcript) return 0
  const actions = transcript.action_items ? parseJsonArray<string>(transcript.action_items).length : 0
  const points = transcript.key_points ? parseJsonArray<string>(transcript.key_points).length : 0
  return actions + points
}

// Location → Harbor Badge variant + label
const LOCATION_BADGE: Record<string, { variant: 'default' | 'warning' | 'primary' | 'success'; label: string }> = {
  'device-only': { variant: 'warning',  label: 'On Device' },
  'local-only':  { variant: 'primary',  label: 'Downloaded' },
  'both':        { variant: 'success',  label: 'Synced' },
}

interface SourceRowProps {
  recording: UnifiedRecording
  meeting?: Meeting
  transcript?: Transcript
  isPlaying: boolean
  isSelected?: boolean
  isActiveSource?: boolean
  searchQuery?: string
  onSelectionChange?: (id: string, shiftKey: boolean) => void
  onClick?: () => void
  onPlay: () => void
  onStop: () => void
  onDownload?: () => void
  onDelete?: () => void
  onTranscribe?: () => void
  onAskAssistant?: () => void
  onGenerateOutput?: () => void
  isDownloading?: boolean
  downloadProgress?: number
  deviceConnected?: boolean
}

export const SourceRow = memo(function SourceRow({
  recording,
  meeting,
  transcript,
  isPlaying,
  isSelected = false,
  isActiveSource = false,
  searchQuery = '',
  onSelectionChange,
  onClick,
  onPlay,
  onStop,
  onDownload,
  onDelete,
  onTranscribe,
  onAskAssistant,
  onGenerateOutput,
  isDownloading = false,
  downloadProgress,
  deviceConnected = false,
}: SourceRowProps) {
  const canPlay = hasLocalPath(recording)
  const error = useLibraryStore((state) => state.recordingErrors.get(recording.id))

  const { primaryText, source: titleSource } = getDisplayTitle(recording, meeting, transcript)
  const showFilenameInSecondary = titleSource !== 'filename'

  const handleCheckboxClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    onSelectionChange?.(recording.id, e.shiftKey)
  }

  const handleRowClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    if (target.closest('button') || target.closest('[role="checkbox"]') || target.closest('[data-radix-popper-content-wrapper]')) return
    onClick?.()
  }

  // Secondary line: date · duration (· filename if title is not filename)
  const secondaryParts: string[] = [formatDate(recording.dateRecorded)]
  if (recording.duration) secondaryParts.push(formatDuration(recording.duration))
  if (showFilenameInSecondary) secondaryParts.push(recording.filename)
  const secondaryText = secondaryParts.join(' · ')

  const insights = insightCount(transcript)
  const locationBadge = LOCATION_BADGE[recording.location]

  // Check if secondary actions exist (to know whether to render the kebab)
  const hasSecondaryActions = !!(onTranscribe || onDownload || onAskAssistant || onGenerateOutput || onDelete)

  return (
    <div
      className={[
        'group @container flex items-center justify-between py-2 px-3 hover:bg-surface-hover cursor-pointer transition-colors',
        isSelected ? 'bg-accent-strong-soft border-l-2 border-l-accent-strong/50' : 'border-l-2 border-l-transparent',
        isActiveSource ? 'bg-accent-strong-soft border-l-primary' : '',
      ].filter(Boolean).join(' ')}
      role="option"
      onClick={handleRowClick}
      aria-selected={isPlaying || isSelected}
      tabIndex={0}
    >
      {/* Left: checkbox + icon + content */}
      <div className="flex items-center gap-2.5 min-w-0 flex-1">
        {onSelectionChange && (
          <Checkbox
            checked={isSelected}
            onClick={handleCheckboxClick}
            aria-label={`Select ${recording.filename}`}
            className="shrink-0"
          />
        )}
        {/* Icon tile */}
        <div
          className={[
            'flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-md',
            isActiveSource ? 'bg-primary text-primary-foreground' : 'bg-surface-sunken',
          ].join(' ')}
        >
          <StatusIcon recording={recording} />
        </div>

        {/* Content: primary title + secondary meta */}
        <div className="flex-1 min-w-0">
          <p className="text-[13.5px] font-semibold truncate text-ink leading-tight">
            {searchQuery ? highlightText(primaryText, searchQuery) : primaryText}
          </p>
          <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
            <p className="font-mono text-[10.5px] text-ink-muted truncate leading-tight">
              {searchQuery ? highlightText(secondaryText, searchQuery) : secondaryText}
            </p>
            {/* Status pill */}
            {locationBadge && (
              <Badge variant={locationBadge.variant} size="sm" className="shrink-0">
                {locationBadge.label}
              </Badge>
            )}
          </div>
        </div>

        {/* Insight count badge */}
        {insights > 0 && (
          <span
            className="shrink-0 rounded-full bg-accent-2-soft px-[7px] py-0.5 font-mono text-[10px] font-semibold text-accent-2"
            title={`${insights} insight${insights === 1 ? '' : 's'}`}
          >
            {insights}
          </span>
        )}
      </div>

      {/* Right: error + kebab overflow + play/stop */}
      <div className="flex items-center gap-1 shrink-0 ml-2">
        {/* Error indicator — always visible (actionable signal) */}
        {error && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <AlertCircle className="h-3.5 w-3.5 text-danger shrink-0" />
              </TooltipTrigger>
              <TooltipContent>
                <p>{error.message}</p>
                {error.details && <p className="text-xs text-ink-muted mt-1">{error.details}</p>}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}

        {/* Downloading in-progress indicator */}
        {isDownloading && (
          <div className="flex items-center gap-1 text-xs text-ink-muted px-1">
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            <span>{downloadProgress ?? 0}%</span>
          </div>
        )}

        {/* Overflow kebab — hover/focus-reveal */}
        {hasSecondaryActions && !isDownloading && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="opacity-0 group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100 transition-opacity"
                onClick={(e) => e.stopPropagation()}
                aria-label="More actions"
                data-testid="source-row-overflow"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48" onClick={(e) => e.stopPropagation()}>
              {onTranscribe && hasLocalPath(recording) && recording.transcriptionStatus !== 'complete' && (
                <DropdownMenuItem
                  onSelect={() => onTranscribe()}
                  disabled={
                    recording.transcriptionStatus === 'pending' ||
                    recording.transcriptionStatus === 'processing'
                  }
                >
                  {recording.transcriptionStatus === 'processing' ? (
                    <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Wand2 className="mr-2 h-4 w-4" />
                  )}
                  {recording.transcriptionStatus === 'pending'
                    ? 'Transcription Queued'
                    : recording.transcriptionStatus === 'processing'
                      ? 'Transcribing…'
                      : 'Transcribe'}
                </DropdownMenuItem>
              )}
              {onDownload && recording.location === 'device-only' && (
                <DropdownMenuItem
                  onSelect={() => onDownload()}
                  disabled={!deviceConnected}
                >
                  <Download className="mr-2 h-4 w-4" />
                  {deviceConnected ? 'Download' : 'Device not connected'}
                </DropdownMenuItem>
              )}
              {onAskAssistant && (
                <DropdownMenuItem onSelect={() => onAskAssistant()}>
                  <Mic className="mr-2 h-4 w-4" />
                  Ask Assistant
                </DropdownMenuItem>
              )}
              {onGenerateOutput && (
                <DropdownMenuItem onSelect={() => onGenerateOutput()}>
                  <FileText className="mr-2 h-4 w-4" />
                  Generate Output
                </DropdownMenuItem>
              )}
              {onDelete && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => onDelete()}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    {recording.location === 'device-only'
                      ? 'Delete from Device'
                      : recording.location === 'local-only'
                        ? 'Delete Local File'
                        : 'Delete'}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {/* Play / Stop — always visible */}
        {isPlaying ? (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={(e) => { e.stopPropagation(); onStop() }}
            title="Stop playback"
          >
            <Square className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={(e) => { e.stopPropagation(); onPlay() }}
            disabled={!canPlay || error?.type === 'audio_not_found'}
            title={
              error?.type === 'audio_not_found'
                ? 'File missing'
                : canPlay
                  ? 'Play capture'
                  : 'Download to play'
            }
          >
            <Play className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  )
}, (prev, next) => {
  return (
    prev.recording.id === next.recording.id &&
    prev.recording.location === next.recording.location &&
    prev.recording.transcriptionStatus === next.recording.transcriptionStatus &&
    prev.recording.title === next.recording.title &&
    prev.recording.meetingSubject === next.recording.meetingSubject &&
    prev.recording.category === next.recording.category &&
    prev.recording.quality === next.recording.quality &&
    prev.recording.duration === next.recording.duration &&
    prev.recording.size === next.recording.size &&
    prev.isPlaying === next.isPlaying &&
    prev.isSelected === next.isSelected &&
    prev.isActiveSource === next.isActiveSource &&
    prev.isDownloading === next.isDownloading &&
    prev.downloadProgress === next.downloadProgress &&
    prev.transcript?.id === next.transcript?.id &&
    prev.transcript?.title_suggestion === next.transcript?.title_suggestion &&
    prev.meeting?.id === next.meeting?.id &&
    prev.meeting?.subject === next.meeting?.subject &&
    prev.searchQuery === next.searchQuery &&
    prev.onSelectionChange === next.onSelectionChange &&
    prev.onClick === next.onClick
  )
})
```

- [ ] **Step 2: Run typecheck**

```bash
cd apps/electron && npm run typecheck:web 2>&1 | grep -E "error TS|Found [0-9]+ error"
```

Expected: `Found 0 errors`.

- [ ] **Step 3: Run tests**

```bash
cd apps/electron && npm run test:run 2>&1 | tail -30
```

Expected: passing. If a test asserts on an always-visible button (e.g. Download, Transcribe, Delete) that is now in the overflow menu, update the test to open the overflow menu first: `fireEvent.click(screen.getByTestId('source-row-overflow'))`, then find the button.

- [ ] **Step 4: Commit**

```bash
cd apps/electron && git add src/features/library/components/SourceRow.tsx && git commit -m "feat(library): content-first row — status pill, overflow menu for secondary actions"
```

---

## Task 5: Update Library.test.tsx for new layout behavior

The test file mocks `useLibraryStore` and asserts on behaviors that change with the new layout. Specifically:
- `selectedSourceId` and `setSelectedSourceId` must be in the mock state (they may not be).
- `assistantOpen` and `setAssistantOpen` must be in the mock state.
- Any test asserting "Recording list" region, "Recording content viewer" region behavior may be affected by the conditional mounting.

**Files:**
- Modify: `apps/electron/src/pages/__tests__/Library.test.tsx`

**Interfaces:**
- Consumes the updated mock for `useLibraryStore`.

- [ ] **Step 1: Check existing mock for missing fields**

Read the current mock in `Library.test.tsx`. The mock at line 79 provides `selectedSourceId: null` and `setSelectedSourceId: vi.fn()`. Also needed: `assistantOpen: false`, `setAssistantOpen: vi.fn()`, `toggleAssistant: vi.fn()`, `selectSingle: vi.fn()`.

- [ ] **Step 2: Add missing fields to the useLibraryStore mock**

In the `vi.mock('@/store/useLibraryStore', ...)` block, ensure the state object includes:

```typescript
assistantOpen: false,
setAssistantOpen: vi.fn(),
toggleAssistant: vi.fn(),
selectSingle: vi.fn(),
filterMode: 'semantic',
semanticFilter: 'all',
exclusiveFilter: 'all',
categoryFilter: null,
qualityFilter: null,
statusFilter: null,
searchQuery: '',
```

- [ ] **Step 3: Run all tests and fix any failures**

```bash
cd apps/electron && npm run test:run 2>&1 | grep -E "FAIL|PASS|error" | head -50
```

If tests fail because they check for a "No recording selected" placeholder (which is now removed), update those tests to check that `screen.queryByText(/no recording selected/i)` is `null` — or remove the assertion if it was testing the old broken behavior.

If tests fail because `screen.getByRole('region', { name: /recording content viewer/i })` is absent (detail not mounted when `selectedSourceId === null`), update the test to first set `selectedSourceId` in the mock to a valid ID, or simply remove assertions that relied on the always-mounted detail region.

- [ ] **Step 4: Run full test suite**

```bash
cd apps/electron && npm run test:run 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
cd apps/electron && git add src/pages/__tests__/Library.test.tsx && git commit -m "test(library): update mocks and assertions for content-width layout changes"
```

---

## Task 6: Final verification gate

Run all three quality gates and capture output.

**Files:** None (read-only verification).

- [ ] **Step 1: TypeScript**

```bash
cd apps/electron && npm run typecheck:web 2>&1 | tail -5
```

Expected output: `Found 0 errors.`

- [ ] **Step 2: Tests**

```bash
cd apps/electron && npm run test:run 2>&1 | tail -10
```

Expected: all tests pass, no failures.

- [ ] **Step 3: Build**

```bash
cd apps/electron && npm run build 2>&1 | tail -20
```

Expected: no errors; build artifacts emitted.

- [ ] **Step 4: Final commit if any loose changes**

```bash
cd apps/electron && git status
```

If clean, nothing to do. If there are unstaged fixes from previous steps, stage and commit them with an appropriate message.

---

## Self-Review Checklist

**Spec coverage:**
- Problem #1 (detail pane conditional on selection) → Task 2 + Task 3. ✓
- Content-width breakpoint 1100px via ResizeObserver (not window.innerWidth) → Task 2. ✓
- List fills full width when `selectedId == null` → Task 2 (no fixed width in that state). ✓
- List is 300px fixed rail when selected + wide → Task 2 (`w-[300px]`). ✓
- List hidden + back bar when selected + narrow → Task 2. ✓
- Deselect on Esc → Task 2 (keydown handler). ✓
- Deselect on clicking already-selected row → Task 3 (`handleRowClick` toggle). ✓
- Assistant drawer preserved, overlays all states → Task 2 (drawer at bottom of TriPaneLayout, outside conditional blocks). ✓
- Transitions ~200ms ease-out, `motion-safe:` prefix → Task 2. ✓
- `prefers-reduced-motion` respected via `motion-safe:` → Task 2. ✓
- ResizeObserver guard for test env → Task 1 (mock) + Task 2 (guard). ✓
- Problem #2 (content-first rows) → Task 4. ✓
- Primary line: title, truncated → Task 4. ✓
- Secondary line: date · duration, mono, muted → Task 4. ✓
- Always-visible: checkbox + play only → Task 4. ✓
- Overflow menu: transcribe / download / ask / generate / delete → Task 4. ✓
- Hover-reveal kebab → Task 4 (`opacity-0 group-hover:opacity-100`). ✓
- Status pill with label (Badge) → Task 4 (`LOCATION_BADGE` map). ✓
- BulkActionsBar already renders only when `selectedCount > 0` (confirmed in `BulkActionsBar.tsx` line 37: `if (selectedCount === 0) return null`). ✓
- Library.tsx removes "No recording selected" placeholder reliance → Task 3 (gate centerPanel on `selectedRecording`). ✓
- SourceReader receives `recording={selectedRecording}` not nullable when detail is shown → Task 3. ✓

**Placeholder scan:** No TBD, TODO, or "implement later" in plan. Code blocks provided for all changes. ✓

**Type consistency:** `DropdownMenuSeparator` and `DropdownMenuContent` are both exported from `@/components/ui/dropdown-menu` (confirmed from file read). `Badge` variants `warning`/`primary`/`success` match the `badgeVariants` CVA definition confirmed in `badge.tsx`. `size="icon-sm"` on `Button` — verify this variant exists in the app's button.tsx before implementing; if absent, use `size="sm"` with `w-7 h-7 p-0`. ✓

**`X` icon replaced with `Square`** in the play/stop area (spec says play button on the right; using `Square` for stop is clearer at small sizes). If the existing tests check for an `X` icon in the stop button, update them to `Square`.
