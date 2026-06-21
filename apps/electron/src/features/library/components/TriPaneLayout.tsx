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
 *  leftPanel  – capture list (full-width, fixed rail, or hidden)
 *  centerPanel – source detail (mounted ONLY when selectedId != null)
 *  rightPanel  – AI assistant (overlay drawer; opened via assistantOpen store flag)
 *
 * Assistant drawer is ALWAYS preserved and overlays all layout states.
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

  // Esc: close assistant drawer first; if already closed and detail open, deselect
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
        role="region"
        aria-label="Recording list"
        aria-hidden={listIsHidden || undefined}
        className={[
          'h-full overflow-auto flex-shrink-0',
          'motion-safe:transition-[width,opacity] motion-safe:duration-200 motion-safe:ease-out',
          listIsHidden
            ? 'w-0 opacity-0 pointer-events-none overflow-hidden'
            : listIsRail
              ? 'w-[300px] border-r border-border'
              : 'flex-1',
        ].join(' ')}
      >
        {leftPanel}
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
