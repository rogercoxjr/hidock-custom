/**
 * Tests for TriPaneLayout (Library UX redesign B + inline Assistant column).
 *
 * Two independent content-width breakpoints:
 *  • NARROW_BREAKPOINT (1100px)    drives the LIST collapse (rail vs hidden)
 *  • ASSISTANT_BREAKPOINT (1180px) drives the Assistant column vs overlay drawer
 *
 * List states:
 *  • nothing selected  → list full-width, NO resizable group, detail not mounted
 *  • selected + wide   → resizable rail + detail (ResizablePanelGroup)
 *  • selected + narrow → detail full-bleed with a back bar
 *
 * Assistant states:
 *  • desktop (W ≥ 1180) → INLINE column, open by default; collapsible; NO scrim,
 *                         NO floating toggle, NO drawer.
 *  • narrow  (W < 1180) → overlay DRAWER, closed by default; floating toggle +
 *                         scrim; NO inline column.
 *
 * ResizeObserver is mocked in src/test/setup.ts and never fires, so content width is
 * driven purely by the synchronous offsetWidth read on mount — set per-test below.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TriPaneLayout } from '../TriPaneLayout'
import { useLibraryStore } from '@/store/useLibraryStore'

// jsdom reports offsetWidth = 0; the content-width breakpoints read that on mount.
// Stub a width so the desired branch is exercised deterministically. Restored per-test.
let offsetWidthSpy: ReturnType<typeof vi.spyOn> | null = null
const setContentWidth = (px: number) => {
  offsetWidthSpy?.mockRestore()
  offsetWidthSpy = vi
    .spyOn(window.HTMLElement.prototype, 'offsetWidth', 'get')
    .mockReturnValue(px)
}

const Left = () => <div data-testid="left-panel">LIST</div>
const Center = () => <div data-testid="center-panel">DETAIL</div>
const Right = () => <div data-testid="right-panel">ASSISTANT</div>

const renderLayout = () =>
  render(<TriPaneLayout leftPanel={<Left />} centerPanel={<Center />} rightPanel={<Right />} />)

describe('TriPaneLayout', () => {
  beforeEach(() => {
    // Reset the relevant store slice between tests.
    const s = useLibraryStore.getState()
    s.setSelectedSourceId(null)
    s.setAssistantOpen(false)
    s.setAssistantInlineOpen(true) // desktop default: inline column visible
    s.setPanelSizes([25, 45, 30])
    // Default to a wide desktop window (≥ 1180) so the rail + inline-column branch runs.
    setContentWidth(1400)
  })

  afterEach(() => {
    offsetWidthSpy?.mockRestore()
    offsetWidthSpy = null
  })

  it('nothing selected → list full-width, NO resizable handle, detail not mounted', () => {
    const { container } = renderLayout()
    expect(screen.getByTestId('left-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('center-panel')).toBeNull()
    // The resize handle (react-resizable-panels) is absent in the full-width state.
    expect(container.querySelector('[data-resize-handle]')).toBeNull()
  })

  it('selected + wide → mounts a draggable rail + detail (resizable handle present)', () => {
    useLibraryStore.getState().setSelectedSourceId('rec-1')
    const { container } = renderLayout()
    expect(screen.getByTestId('left-panel')).toBeInTheDocument()
    expect(screen.getByTestId('center-panel')).toBeInTheDocument()
    // react-resizable-panels marks the drag handle with data-resize-handle.
    expect(container.querySelector('[data-resize-handle]')).not.toBeNull()
  })

  it('selected + narrow → no resizable group, detail full-bleed with a back bar', () => {
    setContentWidth(800) // below the 1100px breakpoint
    useLibraryStore.getState().setSelectedSourceId('rec-1')
    const { container } = renderLayout()
    expect(screen.getByTestId('center-panel')).toBeInTheDocument()
    expect(container.querySelector('[data-resize-handle]')).toBeNull()
    expect(screen.getByLabelText(/back to library list/i)).toBeInTheDocument()
  })

  // --- Assistant: desktop INLINE column (W ≥ 1180) ---

  it('desktop → renders the inline Assistant column by default (no scrim, no floating toggle)', () => {
    renderLayout()
    expect(screen.getByRole('region', { name: /ai assistant/i })).toBeInTheDocument()
    expect(screen.getByTestId('right-panel')).toBeInTheDocument()
    // No floating "open" toggle and no "collapse" → it is the inline column, not a drawer.
    expect(screen.queryByLabelText(/open ai assistant panel/i)).toBeNull()
    expect(screen.getByLabelText(/collapse ai assistant panel/i)).toBeInTheDocument()
  })

  it('desktop → collapsing removes the inline column and reveals a header re-open toggle', () => {
    useLibraryStore.getState().setSelectedSourceId('rec-1') // detail mounted (header host)
    useLibraryStore.getState().setAssistantInlineOpen(false)
    renderLayout()
    // Column gone — its region/content unmounted.
    expect(screen.queryByRole('region', { name: /ai assistant/i })).toBeNull()
    expect(screen.queryByTestId('right-panel')).toBeNull()
    // Re-open affordance present in the detail header (desktop, NOT the floating button).
    expect(screen.getByLabelText(/show ai assistant panel/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/open ai assistant panel/i)).toBeNull()
  })

  // --- Assistant: narrow overlay DRAWER (W < 1180) ---

  it('narrow → keeps the floating Assistant toggle when the drawer is closed', () => {
    setContentWidth(900) // below the 1180px assistant breakpoint
    renderLayout()
    expect(screen.getByLabelText(/open ai assistant panel/i)).toBeInTheDocument()
    // No inline column on narrow widths.
    expect(screen.queryByRole('region', { name: /ai assistant/i })).toBeNull()
  })

  it('narrow → renders the Assistant overlay drawer when open', () => {
    setContentWidth(900) // below the 1180px assistant breakpoint
    useLibraryStore.getState().setAssistantOpen(true)
    renderLayout()
    expect(screen.getByRole('region', { name: /ai assistant/i })).toBeInTheDocument()
    expect(screen.getByTestId('right-panel')).toBeInTheDocument()
    // Drawer uses Close (not Collapse) and has no floating re-open toggle while open.
    expect(screen.getByLabelText(/close ai assistant panel/i)).toBeInTheDocument()
  })

  it('narrow → inline column does NOT render even when assistantInlineOpen is true', () => {
    setContentWidth(900)
    useLibraryStore.getState().setAssistantInlineOpen(true)
    useLibraryStore.getState().setAssistantOpen(false)
    renderLayout()
    // Inline flag is true but width is narrow → no inline column, just the floating toggle.
    expect(screen.queryByRole('region', { name: /ai assistant/i })).toBeNull()
    expect(screen.getByLabelText(/open ai assistant panel/i)).toBeInTheDocument()
  })
})
