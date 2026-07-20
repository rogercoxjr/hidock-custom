/**
 * Device-safety regression guard: the SourceCard per-recording Download control
 * MUST be disabled while a device sync is already in flight (`deviceSyncing`).
 *
 * WHY: downloads stream through ONE shared USB read loop (transferIn). If a user
 * starts a second download mid-sync, the two reads collide on that single loop and
 * produce 0-byte / corrupt files and can lock the USB device. Gating every
 * download-START control on `deviceSyncing` prevents the concurrent trigger.
 *
 * SourceCard is the chosen target because its Download affordance is a direct
 * <Button> (not buried in a Radix dropdown like SourceRow), so it renders and is
 * queryable in isolation with minimal mocking.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SourceCard } from '../SourceCard'
import type { UnifiedRecording } from '@/types/unified-recording'

// SourceCard reads recordingErrors from the library store — provide an empty map.
vi.mock('@/store/useLibraryStore', () => ({
  useLibraryStore: vi.fn((selector?: (s: { recordingErrors: Map<string, unknown> }) => unknown) => {
    const state = { recordingErrors: new Map<string, unknown>() }
    return typeof selector === 'function' ? selector(state) : state
  })
}))

const deviceOnlyRecording: UnifiedRecording = {
  id: 'rec-dev-1',
  filename: 'meeting.hda',
  size: 2048000,
  duration: 240,
  dateRecorded: new Date('2026-06-01T10:00:00Z'),
  location: 'device-only',
  deviceFilename: 'meeting.hda',
  syncStatus: 'not-synced',
  transcriptionStatus: 'none',
  title: 'Weekly Sync'
} as unknown as UnifiedRecording

const renderCard = (props: Partial<React.ComponentProps<typeof SourceCard>> = {}) =>
  render(
    <SourceCard
      recording={deviceOnlyRecording}
      isPlaying={false}
      isTranscriptExpanded={false}
      isDownloading={false}
      isDeleting={false}
      deviceConnected={true}
      onClick={vi.fn()}
      onPlay={vi.fn()}
      onStop={vi.fn()}
      onDownload={vi.fn()}
      onDelete={vi.fn()}
      onAskAssistant={vi.fn()}
      onGenerateOutput={vi.fn()}
      onToggleTranscript={vi.fn()}
      onNavigateToMeeting={vi.fn()}
      {...props}
    />
  )

describe('SourceCard download gating on deviceSyncing', () => {
  beforeEach(() => vi.clearAllMocks())

  it('disables the Download button when a sync is already in flight (deviceSyncing=true)', () => {
    renderCard({ deviceSyncing: true })
    const downloadBtn = screen.getByTitle('Download to computer')
    expect(downloadBtn).toBeDisabled()
  })

  it('enables the Download button when no sync is in flight (deviceSyncing=false)', () => {
    renderCard({ deviceSyncing: false })
    const downloadBtn = screen.getByTitle('Download to computer')
    expect(downloadBtn).not.toBeDisabled()
  })
})
