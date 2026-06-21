/**
 * TriPaneLayout Component
 *
 * Content-width-driven master/detail layout for the Library page.
 * Measures the container with ResizeObserver. Two independent breakpoints:
 *   • NARROW_BREAKPOINT (1100px)    → drives the LIST collapse (rail vs hidden)
 *   • ASSISTANT_BREAKPOINT (1180px) → drives the Assistant column vs drawer
 *
 * List layout states (W = content width, selectedId from useLibraryStore):
 *  selectedId == null               → list fills full width; detail NOT mounted
 *  selectedId != null, W ≥ 1100px   → DRAGGABLE rail + detail (ResizablePanelGroup)
 *  selectedId != null, W < 1100px   → list hidden; detail full-bleed + back bar
 *
 * Assistant layout states (W = content width):
 *  W ≥ 1180px  → INLINE column: a real third pane (flex:none, 340px) appended after
 *                the list+detail group. No scrim, no slide, no transform. Rendered
 *                only when open (assistantInlineOpen, default true on desktop), so
 *                closing removes it cleanly. Optional ~120ms opacity settle.
 *  W < 1180px  → overlay DRAWER: navy scrim + 380px slide-over + floating toggle +
 *                Esc/scrim close (assistantOpen, default closed each session).
 *
 * Panels:
 *  leftPanel   – capture list (full-width, resizable rail, or hidden)
 *  centerPanel – source detail (mounted ONLY when selectedId != null)
 *  rightPanel  – AI assistant (inline column on desktop / overlay drawer on narrow)
 *
 * Rail+detail split (wide + selected) is drag-to-resize via react-resizable-panels.
 * Sizes persist in useLibraryStore.panelSizes ([railPct, detailPct]); the rail is
 * clamped to ~22%–40% of width.
 */

import { useRef, useEffect, useState, useCallback } from 'react'
import { ChevronLeft, ChevronRight, Sparkles } from 'lucide-react'
import { useLibraryStore } from '@/store/useLibraryStore'
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable'

const NARROW_BREAKPOINT = 1100 // px of content width — drives the LIST collapse
const ASSISTANT_BREAKPOINT = 1180 // px of content width — inline column vs overlay drawer
const ASSISTANT_COLUMN_WIDTH = 340 // px — inline Assistant column

// Rail size clamps (percent of the rail+detail group width).
const RAIL_MIN_PCT = 22 // ≈ 240px at the 1100px breakpoint
const RAIL_MAX_PCT = 40 // ≈ 480px
const RAIL_DEFAULT_PCT = 25

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
  const assistantInlineOpen = useLibraryStore((s) => s.assistantInlineOpen)
  const setAssistantInlineOpen = useLibraryStore((s) => s.setAssistantInlineOpen)
  const panelSizes = useLibraryStore((s) => s.panelSizes)
  const setPanelSizes = useLibraryStore((s) => s.setPanelSizes)

  // Default to a wide width so the test env (ResizeObserver mocked, never fires) and
  // first paint land on the desktop branch. The synchronous offsetWidth read on mount
  // corrects this immediately.
  const [contentWidth, setContentWidth] = useState(ASSISTANT_BREAKPOINT)
  const containerRef = useRef<HTMLDivElement>(null)

  // Observe container width — guard for test environments without ResizeObserver
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? el.offsetWidth
      setContentWidth(width)
    })
    ro.observe(el)
    // Run once synchronously on mount
    setContentWidth(el.offsetWidth)
    return () => ro.disconnect()
  }, [])

  const contentNarrow = contentWidth < NARROW_BREAKPOINT
  const assistantIsDrawer = contentWidth < ASSISTANT_BREAKPOINT

  const showDetail = selectedSourceId != null
  const listIsRail = showDetail && !contentNarrow
  const listIsHidden = showDetail && contentNarrow

  // The inline column shows on desktop when toggled open; the overlay drawer shows on
  // narrow widths when toggled open. Each width mode respects its own user toggle.
  const showInlineAssistant = !assistantIsDrawer && assistantInlineOpen
  const showDrawerAssistant = assistantIsDrawer && assistantOpen

  const handleDeselect = useCallback(() => {
    setSelectedSourceId(null)
  }, [setSelectedSourceId])

  // Esc: in drawer mode, close the drawer first; otherwise (or once closed) deselect
  // the detail. The inline column is non-modal, so Esc never closes it.
  useEffect(() => {
    if (!showDrawerAssistant && !showDetail) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (showDrawerAssistant) {
        setAssistantOpen(false)
      } else if (showDetail) {
        handleDeselect()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showDrawerAssistant, showDetail, setAssistantOpen, handleDeselect])

  // Seed the rail's default size from persisted panelSizes[0], clamped to range.
  const persistedRail = panelSizes?.[0]
  const railDefault =
    typeof persistedRail === 'number' && persistedRail >= RAIL_MIN_PCT && persistedRail <= RAIL_MAX_PCT
      ? persistedRail
      : RAIL_DEFAULT_PCT

  // Persist the two-panel layout ([railPct, detailPct]) as the user drags.
  const handleLayout = useCallback(
    (sizes: number[]) => {
      if (sizes.length === 2) setPanelSizes(sizes)
    },
    [setPanelSizes]
  )

  // A small "Assistant" toggle for the detail header (desktop only). Lets the user
  // re-open the inline column after collapsing it, without the floating round button.
  const inlineToggleButton = !assistantIsDrawer && !assistantInlineOpen && (
    <button
      onClick={() => setAssistantInlineOpen(true)}
      className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-sm text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
      aria-label="Show AI assistant panel"
    >
      <Sparkles className="h-4 w-4" aria-hidden="true" />
      Assistant
    </button>
  )

  // The detail panel content (back bar shows only in the narrow/hidden state).
  // Eases in (fade + slide from right) when it mounts on selection, so the reader
  // doesn't pop in. One-shot on mount — navigating between records keeps it mounted,
  // so it doesn't re-animate on every record switch.
  const detailContent = (
    <div className="flex min-w-0 flex-1 flex-col h-full overflow-hidden motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-4 motion-safe:duration-200">
      {/* Header bar — back button when list is hidden (narrow), and/or the desktop
          inline-assistant re-open toggle. Rendered only when it has something to show. */}
      {(listIsHidden || inlineToggleButton) && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-surface px-3 py-2">
          {listIsHidden ? (
            <button
              onClick={handleDeselect}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-sm text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
              aria-label="Back to library list"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              Library
            </button>
          ) : (
            <span aria-hidden="true" />
          )}
          {inlineToggleButton}
        </div>
      )}
      <div role="region" aria-label="Recording content viewer" className="min-h-0 flex-1 overflow-hidden">
        {centerPanel}
      </div>
    </div>
  )

  // The inline Assistant column — a real third pane on desktop. No scrim/slide; an
  // optional opacity settle (motion-safe) when it appears. Collapse via the "›" header
  // button. Rendered ONLY when open, so closing removes it (no empty 340px gap).
  const inlineAssistant = showInlineAssistant && (
    <div
      role="region"
      aria-label="AI Assistant"
      style={{ width: ASSISTANT_COLUMN_WIDTH }}
      className="flex h-full min-h-0 flex-none flex-col border-l border-border bg-surface motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150"
    >
      <div className="flex items-center justify-between border-b border-border bg-surface-sunken p-3">
        <h3 className="font-semibold text-ink">AI Assistant</h3>
        <button
          onClick={() => setAssistantInlineOpen(false)}
          className="rounded-md p-1.5 transition-colors hover:bg-surface-hover"
          aria-label="Collapse AI assistant panel"
        >
          <ChevronRight className="h-4 w-4 text-ink-muted" aria-hidden="true" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">{rightPanel}</div>
    </div>
  )

  return (
    <div ref={containerRef} className="relative flex h-full overflow-hidden">
      {/* List + detail group (inline Assistant becomes a flex:none sibling after it) */}
      <div className="flex min-w-0 flex-1 overflow-hidden">
        {listIsRail ? (
          // WIDE + SELECTED → draggable rail + detail split. The whole rail+detail
          // group fades in on mount so the switch from the full-width list eases in
          // (masking the list's reflow to the narrow rail) rather than snapping.
          <ResizablePanelGroup
            direction="horizontal"
            className="h-full w-full motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200"
            onLayout={handleLayout}
          >
            <ResizablePanel
              defaultSize={railDefault}
              minSize={RAIL_MIN_PCT}
              maxSize={RAIL_MAX_PCT}
              className="h-full overflow-auto"
            >
              <div role="region" aria-label="Recording list" className="h-full overflow-auto">
                {leftPanel}
              </div>
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={100 - railDefault} minSize={40} className="h-full overflow-hidden">
              {detailContent}
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          <>
            {/* List panel — full width | hidden (narrow + selected) */}
            <div
              role="region"
              aria-label="Recording list"
              aria-hidden={listIsHidden || undefined}
              className={[
                'h-full overflow-auto flex-shrink-0',
                'motion-safe:transition-[width,opacity] motion-safe:duration-200 motion-safe:ease-out',
                listIsHidden ? 'w-0 opacity-0 pointer-events-none overflow-hidden' : 'flex-1',
              ].join(' ')}
            >
              {leftPanel}
            </div>

            {/* Detail panel — only mounted when something is selected (narrow state) */}
            {showDetail && detailContent}
          </>
        )}
      </div>

      {/* AI Assistant — INLINE column on desktop (≥ 1180px) */}
      {inlineAssistant}

      {/* AI Assistant — overlay DRAWER on narrow widths (< 1180px) */}
      {showDrawerAssistant && (
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

      {/* Floating toggle to summon the drawer — narrow widths only */}
      {assistantIsDrawer && !assistantOpen && (
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
