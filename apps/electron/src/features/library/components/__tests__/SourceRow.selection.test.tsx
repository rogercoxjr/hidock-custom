/**
 * Tests for SourceRow modifier-click selection (Library UX redesign A).
 *
 * The leading multi-select <Checkbox> was removed. Multi-select is now driven by
 * Finder-style modifier-clicks routed through the unified `onClick(e)` handler,
 * which forwards the raw mouse event so the parent (Library.tsx) can read
 * shift / cmd / ctrl modifiers. These tests assert the new contract at the
 * component boundary:
 *   • no checkbox is rendered
 *   • onClick receives the MouseEvent (with modifier flags) on plain / shift /
 *     cmd / ctrl clicks
 *   • clicking action buttons (play / overflow) does NOT route to onClick
 *   • bulk-selected rows expose data-selected for the distinct selection tint
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SourceRow } from '../SourceRow'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { UnifiedRecording } from '@/types/unified-recording'

// SourceRow reads recordingErrors from the library store — provide an empty map.
vi.mock('@/store/useLibraryStore', () => ({
  useLibraryStore: vi.fn((selector?: any) => {
    const state = { recordingErrors: new Map() }
    return typeof selector === 'function' ? selector(state) : state
  })
}))

const baseRecording: UnifiedRecording = {
  id: 'rec-1',
  filename: 'standup.wav',
  quality: 'valuable',
  duration: 120,
  size: 1024000,
  dateRecorded: new Date('2026-06-01T10:00:00Z'),
  location: 'local-only',
  localPath: '/path/standup.wav',
  syncStatus: 'synced',
  transcriptionStatus: 'complete',
  title: 'Daily Standup'
} as unknown as UnifiedRecording

const renderRow = (props: Partial<React.ComponentProps<typeof SourceRow>> = {}) => {
  const onClick = vi.fn()
  const onPlay = vi.fn()
  const onStop = vi.fn()
  render(
    <TooltipProvider>
      <SourceRow
        recording={baseRecording}
        isPlaying={false}
        onClick={onClick}
        onPlay={onPlay}
        onStop={onStop}
        {...props}
      />
    </TooltipProvider>
  )
  return { onClick, onPlay, onStop }
}

describe('SourceRow modifier-click selection', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does not render a selection checkbox', () => {
    renderRow()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByLabelText(/^Select /)).toBeNull()
  })

  it('routes a plain click to onClick with no modifiers', () => {
    const { onClick } = renderRow()
    const row = screen.getByRole('option')
    fireEvent.click(row)
    expect(onClick).toHaveBeenCalledTimes(1)
    const evt = onClick.mock.calls[0][0]
    expect(evt.shiftKey).toBe(false)
    expect(evt.metaKey).toBe(false)
    expect(evt.ctrlKey).toBe(false)
  })

  it('forwards the shiftKey modifier on a shift-click', () => {
    const { onClick } = renderRow()
    const row = screen.getByRole('option')
    fireEvent.click(row, { shiftKey: true })
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onClick.mock.calls[0][0].shiftKey).toBe(true)
  })

  it('forwards the metaKey modifier on a cmd-click', () => {
    const { onClick } = renderRow()
    const row = screen.getByRole('option')
    fireEvent.click(row, { metaKey: true })
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onClick.mock.calls[0][0].metaKey).toBe(true)
  })

  it('forwards the ctrlKey modifier on a ctrl-click', () => {
    const { onClick } = renderRow()
    const row = screen.getByRole('option')
    fireEvent.click(row, { ctrlKey: true })
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onClick.mock.calls[0][0].ctrlKey).toBe(true)
  })

  it('does NOT route to onClick when an action button is clicked', () => {
    const { onClick, onPlay } = renderRow()
    // Play is always rendered for a local recording.
    fireEvent.click(screen.getByRole('button', { name: /play capture/i }))
    expect(onPlay).toHaveBeenCalledTimes(1)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('marks bulk-selected rows with data-selected for the distinct selection tint', () => {
    renderRow({ isSelected: true })
    expect(screen.getByRole('option').getAttribute('data-selected')).toBe('true')
  })

  it('does not mark unselected rows', () => {
    renderRow({ isSelected: false })
    expect(screen.getByRole('option').getAttribute('data-selected')).toBeNull()
  })
})
