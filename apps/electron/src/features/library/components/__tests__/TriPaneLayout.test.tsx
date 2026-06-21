/**
 * Tests for TriPaneLayout (Library UX redesign B).
 *
 * The rail+detail split is drag-to-resize via react-resizable-panels when a
 * recording is selected on a wide window. The other layout states are preserved:
 *  • nothing selected  → list full-width, NO resizable group, detail not mounted
 *  • selected + wide   → resizable rail + detail (ResizablePanelGroup)
 *  • Assistant overlay → floating toggle when closed; drawer when open
 *
 * ResizeObserver is mocked in src/test/setup.ts and never fires, so contentNarrow
 * stays at its wide default — the wide branch is what we exercise here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TriPaneLayout } from '../TriPaneLayout'
import { useLibraryStore } from '@/store/useLibraryStore'

// jsdom reports offsetWidth = 0, which the content-width breakpoint would read as
// "narrow". Stub a wide offsetWidth so the wide (rail/resizable) branch is exercised
// deterministically. Restored per-test by the offsetWidth helper below.
let offsetWidthSpy: ReturnType<typeof vi.spyOn> | null = null
const setContentWidth = (px: number) => {
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
    s.setPanelSizes([25, 45, 30])
    // Default to a wide window so the rail/resizable branch is reachable.
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

  it('keeps the floating Assistant toggle when the drawer is closed', () => {
    renderLayout()
    expect(screen.getByLabelText(/open ai assistant panel/i)).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: /ai assistant/i })).toBeNull()
  })

  it('renders the Assistant overlay drawer when open', () => {
    useLibraryStore.getState().setAssistantOpen(true)
    renderLayout()
    expect(screen.getByRole('region', { name: /ai assistant/i })).toBeInTheDocument()
    expect(screen.getByTestId('right-panel')).toBeInTheDocument()
  })
})
