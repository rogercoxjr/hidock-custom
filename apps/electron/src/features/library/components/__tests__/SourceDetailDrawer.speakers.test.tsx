/**
 * SourceDetailDrawer — SpeakersPanel wiring (D3-T3 Fix 2)
 *
 * Asserts the drawer fetches the recording's speaker assignments on open and
 * re-fetches BOTH the transcript turns and the assignment names when the panel's
 * onChanged fires (so assign/merge/reassign reflect live without closing).
 *
 * SpeakersPanel is stubbed to a lightweight surface so this test focuses purely on
 * the drawer's fetch + refresh wiring (the panel's own behavior is covered in
 * SpeakersPanel.test.tsx).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SourceDetailDrawer } from '../SourceDetailDrawer'
import type { UnifiedRecording } from '@/types/unified-recording'

// --- Mocks ---------------------------------------------------------------

vi.mock('@/components/ui/toaster', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))

vi.mock('@/components/AudioPlayer', () => ({
  AudioPlayer: () => <div data-testid="audio-player" />,
}))

// Stub the panel: render the assignedNames it receives + a button to fire onChanged.
vi.mock('../SpeakersPanel', () => ({
  SpeakersPanel: ({
    turns,
    assignedNames,
    onChanged,
  }: {
    turns: Array<{ speaker: string }>
    assignedNames?: Record<string, string>
    onChanged: () => void
  }) => (
    <div data-testid="speakers-panel">
      <div data-testid="turn-count">{turns.length}</div>
      <div data-testid="assigned-names">{JSON.stringify(assignedNames ?? {})}</div>
      <button onClick={onChanged}>fire onChanged</button>
    </div>
  ),
}))

const mockGetForRecording = vi.fn()
const mockGetTranscript = vi.fn()

const baseSource: UnifiedRecording = {
  id: 'rec-1',
  filename: 'meeting.hda',
  size: 1024,
  duration: 60,
  dateRecorded: new Date('2026-06-17T10:00:00Z'),
  transcriptionStatus: 'complete',
  location: 'local-only',
  localPath: '/tmp/meeting.hda',
  syncStatus: 'synced',
}

function makeTranscript(turns: Array<{ speaker: string; startMs: number; endMs: number; text: string }>) {
  return {
    id: 't-1',
    recording_id: 'rec-1',
    full_text: 'hello',
    language: 'en',
    summary: null,
    action_items: null,
    topics: null,
    key_points: null,
    sentiment: null,
    speakers: null,
    turns: JSON.stringify(turns),
    word_count: 1,
    transcription_provider: 'assemblyai',
    transcription_model: 'universal-3-pro',
    title_suggestion: null,
    question_suggestions: null,
    created_at: '2026-06-17T10:00:00Z',
  }
}

const defaultProps = {
  source: baseSource,
  isOpen: true,
  isPlaying: false,
  onClose: vi.fn(),
  onPlay: vi.fn(),
  onStop: vi.fn(),
  onTranscribe: vi.fn(),
  onDownload: vi.fn(),
  onDelete: vi.fn(),
  deviceConnected: true,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetForRecording.mockResolvedValue({ success: true, data: { A: { contactId: 'cA', contactName: 'Alice' } } })
  mockGetTranscript.mockResolvedValue(makeTranscript([{ speaker: 'A', startMs: 0, endMs: 1000, text: 'hi' }]))
  Object.defineProperty(window, 'electronAPI', {
    value: {
      speakers: { getForRecording: mockGetForRecording },
      transcripts: { getByRecordingId: mockGetTranscript },
    },
    writable: true,
    configurable: true,
  })
})

describe('SourceDetailDrawer — SpeakersPanel wiring (D3-T3 Fix 2)', () => {
  it('fetches speaker assignments on open and passes assignedNames to the panel', async () => {
    const transcript = makeTranscript([{ speaker: 'A', startMs: 0, endMs: 1000, text: 'hi' }])
    render(<SourceDetailDrawer {...defaultProps} transcript={transcript as any} />)

    await waitFor(() => expect(mockGetForRecording).toHaveBeenCalledWith('rec-1'))
    await waitFor(() =>
      expect(screen.getByTestId('assigned-names').textContent).toBe(JSON.stringify({ A: 'Alice' }))
    )
  })

  it('re-fetches BOTH turns and assignments when the panel reports a change (live refresh)', async () => {
    const transcript = makeTranscript([{ speaker: 'A', startMs: 0, endMs: 1000, text: 'hi' }])
    render(<SourceDetailDrawer {...defaultProps} transcript={transcript as any} />)

    // Initial fetch resolved.
    await waitFor(() => expect(screen.getByTestId('assigned-names').textContent).toBe(JSON.stringify({ A: 'Alice' })))
    expect(screen.getByTestId('turn-count').textContent).toBe('1')

    // After an edit: the next fetches return updated data (renamed + new turn).
    mockGetForRecording.mockResolvedValue({
      success: true,
      data: { A: { contactId: 'cA', contactName: 'Alice Renamed' } },
    })
    mockGetTranscript.mockResolvedValue(
      makeTranscript([
        { speaker: 'A', startMs: 0, endMs: 1000, text: 'hi' },
        { speaker: 'A', startMs: 1000, endMs: 2000, text: 'again' },
      ])
    )

    fireEvent.click(screen.getByText('fire onChanged'))

    // Both IPCs are re-invoked, and the panel reflects the new names + turns.
    await waitFor(() => expect(mockGetTranscript).toHaveBeenCalledWith('rec-1'))
    await waitFor(() =>
      expect(screen.getByTestId('assigned-names').textContent).toBe(JSON.stringify({ A: 'Alice Renamed' }))
    )
    await waitFor(() => expect(screen.getByTestId('turn-count').textContent).toBe('2'))
    // getForRecording called at least twice (mount + after change).
    expect(mockGetForRecording.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})
