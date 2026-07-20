/**
 * Tests for the aggregate failure chip in LibraryHeader (auto-pipeline P4 Task 4).
 *
 * The chip is the single non-silent surface for provider-terminal transcription
 * failures (spec §7.3). It:
 *   - Renders nothing when failedCount === 0
 *   - Shows "N transcriptions failed" + "Retry all" button when count > 0
 *   - Calls onRetryAllFailed when the button is clicked
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { LibraryHeader } from '../LibraryHeader'

// Minimal props that satisfy all non-chip LibraryHeaderProps fields
function makeProps(overrides: Partial<Parameters<typeof LibraryHeader>[0]> = {}) {
  return {
    stats: { total: 5, deviceOnly: 0, localOnly: 5, unsynced: 0 },
    deviceConnected: true,
    deviceSyncing: false,
    loading: false,
    compactView: false,
    downloadQueueSize: 0,
    bulkCounts: { deviceOnly: 0, needsTranscription: 0 },
    bulkProcessing: false,
    bulkProgress: { current: 0, total: 0 },
    failedCount: 0,
    onAddRecording: vi.fn(),
    onOpenFolder: vi.fn(),
    onBulkDownload: vi.fn(),
    onBulkProcess: vi.fn(),
    onRefresh: vi.fn(),
    onSetCompactView: vi.fn(),
    onRetryAllFailed: vi.fn(),
    ...overrides
  }
}

describe('LibraryHeader — failure chip (auto-pipeline P4 Task 4)', () => {
  it('renders nothing for the chip when failedCount is 0', () => {
    const { container } = render(<LibraryHeader {...makeProps({ failedCount: 0 })} />)
    // The chip text should not be present
    expect(screen.queryByText(/transcription.*failed/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /retry all/i })).toBeNull()
    // Suppress unused warning
    void container
  })

  it('shows "1 transcription failed" and Retry all button when failedCount is 1', () => {
    render(<LibraryHeader {...makeProps({ failedCount: 1 })} />)
    expect(screen.getByText(/1 transcription failed/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /retry all/i })).toBeTruthy()
  })

  it('shows "3 transcriptions failed" (plural) when failedCount is 3', () => {
    render(<LibraryHeader {...makeProps({ failedCount: 3 })} />)
    // The chip renders "3 transcriptions failed" (plural)
    const chipText = screen.getByText(/3 transcriptions failed/i)
    expect(chipText).toBeTruthy()
  })

  it('calls onRetryAllFailed when Retry all is clicked', () => {
    const onRetryAllFailed = vi.fn()
    render(<LibraryHeader {...makeProps({ failedCount: 2, onRetryAllFailed })} />)
    const btn = screen.getByRole('button', { name: /retry all/i })
    fireEvent.click(btn)
    expect(onRetryAllFailed).toHaveBeenCalledTimes(1)
  })
})
