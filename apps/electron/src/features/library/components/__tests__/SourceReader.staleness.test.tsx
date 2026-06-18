/**
 * SourceReader — staleness badge (D5-T3, spec §6.6 / AC5)
 *
 * Tests that:
 *  (a) the "generic speaker labels" badge renders when isSummaryStale resolves true;
 *  (b) the badge is absent when isSummaryStale resolves false;
 *  (c) after resummarize the isSummaryStale probe is re-called and the badge clears;
 *  (d) no unhandled rejection when the IPC is absent or rejects.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { SourceReader } from '../SourceReader'
import type { UnifiedRecording } from '@/types/unified-recording'
import type { Transcript } from '@/types'

// --- Mocks ---------------------------------------------------------------

vi.mock('@radix-ui/react-portal', () => ({
  Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@/components/ui/toaster', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))

// AudioPlayer pulls in IPC/media APIs — stub it out.
vi.mock('@/components/AudioPlayer', () => ({
  AudioPlayer: () => <div data-testid="audio-player" />,
}))

vi.mock('@/components/RecordingLinkDialog', () => ({
  RecordingLinkDialog: () => null,
}))

vi.mock('@/components/ConfirmDialog', () => ({
  ConfirmDialog: () => null,
}))

vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

// Stub SpeakersPanel — not relevant to staleness tests.
vi.mock('../SpeakersPanel', () => ({
  SpeakersPanel: () => <div data-testid="speakers-panel" />,
}))

// Stub TranscriptViewer — not relevant to staleness tests.
vi.mock('../TranscriptViewer', () => ({
  TranscriptViewer: () => <div data-testid="transcript-viewer" />,
}))

// --- Helpers -------------------------------------------------------------

const isSummaryStale = vi.fn()

function makeElectronAPI(recordingsOverrides: Record<string, unknown> = {}) {
  return {
    recordings: {
      selectMeeting: vi.fn().mockResolvedValue({ success: true }),
      getCandidates: vi.fn().mockResolvedValue({ success: true, data: [] }),
      getMeetingsNearDate: vi.fn().mockResolvedValue({ success: true, data: [] }),
      isSummaryStale,
      ...recordingsOverrides,
    },
    transcripts: {
      getByRecordingId: vi.fn().mockResolvedValue(null),
    },
    speakers: {
      getForRecording: vi.fn().mockResolvedValue({ success: true, data: {} }),
    },
    knowledge: {
      update: vi.fn().mockResolvedValue({ success: true }),
    },
  }
}

beforeEach(() => {
  isSummaryStale.mockReset()
  Object.defineProperty(window, 'electronAPI', {
    value: makeElectronAPI({}),
    writable: true,
    configurable: true,
  })
})

const recording = {
  id: 'rec-1',
  filename: 'rec-1.hda',
  title: 'Standup',
  location: 'local-only',
  localPath: 'C:/recordings/rec-1.hda',
  transcriptionStatus: 'complete',
  dateRecorded: new Date('2026-06-17T09:00:00Z'),
  size: 1024,
  duration: 60,
} as unknown as UnifiedRecording

const transcript: Transcript = {
  id: 't1',
  recording_id: 'rec-1',
  full_text: 'hello world',
  language: 'en',
  summary: 'A short summary.',
  action_items: null,
  topics: null,
  key_points: null,
  sentiment: null,
  speakers: null,
  word_count: 2,
  transcription_provider: 'assemblyai',
  transcription_model: 'universal-3-pro',
  title_suggestion: 'Standup',
  question_suggestions: null,
  created_at: '2026-06-17T10:00:00Z',
}

const STALE_MSG = /generic speaker labels/i

// --- Tests ---------------------------------------------------------------

describe('SourceReader staleness badge (spec §6.6 / AC5)', () => {

  it('(a) renders the staleness badge when isSummaryStale resolves true', async () => {
    isSummaryStale.mockResolvedValue(true)
    render(<SourceReader recording={recording} transcript={transcript} onResummarize={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(STALE_MSG)).toBeInTheDocument())
    expect(isSummaryStale).toHaveBeenCalledWith('rec-1')
  })

  it('(b) does NOT render the badge when isSummaryStale resolves false', async () => {
    isSummaryStale.mockResolvedValue(false)
    render(<SourceReader recording={recording} transcript={transcript} onResummarize={vi.fn()} />)
    await waitFor(() => expect(isSummaryStale).toHaveBeenCalled())
    expect(screen.queryByText(STALE_MSG)).not.toBeInTheDocument()
  })

  it('(c) after resummarize isSummaryStale is re-called and badge clears', async () => {
    // First call → stale (badge shows); second call → fresh (badge clears).
    isSummaryStale.mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    const onResummarize = vi.fn()
    const { rerender } = render(
      <SourceReader recording={recording} transcript={transcript} onResummarize={onResummarize} />,
    )

    // Badge should appear initially.
    await waitFor(() => expect(screen.getByText(STALE_MSG)).toBeInTheDocument())

    // Simulate parent refreshing transcript (timestamp changes → new object reference).
    const freshTranscript: Transcript = { ...transcript, created_at: '2026-06-17T11:00:00Z' }
    rerender(
      <SourceReader recording={recording} transcript={freshTranscript} onResummarize={onResummarize} />,
    )

    // Effect re-runs → second isSummaryStale call → false → badge clears.
    await waitFor(() => expect(screen.queryByText(STALE_MSG)).not.toBeInTheDocument())
    expect(isSummaryStale).toHaveBeenCalledTimes(2)
  })

  it('(d) no unhandled rejection when IPC is absent', async () => {
    // Remove isSummaryStale from the recordings namespace.
    Object.defineProperty(window, 'electronAPI', {
      value: makeElectronAPI({ isSummaryStale: undefined }),
      writable: true,
      configurable: true,
    })

    // Should mount without throwing.
    expect(() =>
      render(<SourceReader recording={recording} transcript={transcript} onResummarize={vi.fn()} />),
    ).not.toThrow()

    // No stale badge should appear.
    await waitFor(() => {}, { timeout: 50 })
    expect(screen.queryByText(STALE_MSG)).not.toBeInTheDocument()
  })

  it('(d2) no unhandled rejection when IPC rejects', async () => {
    isSummaryStale.mockRejectedValue(new Error('IPC error'))

    // Should mount without throwing.
    expect(() =>
      render(<SourceReader recording={recording} transcript={transcript} onResummarize={vi.fn()} />),
    ).not.toThrow()

    // Badge should NOT appear (catch branch → setSummaryStale(false)).
    await waitFor(() => {}, { timeout: 100 })
    expect(screen.queryByText(STALE_MSG)).not.toBeInTheDocument()
  })

  it('does NOT probe staleness when there is no transcript', async () => {
    isSummaryStale.mockResolvedValue(true)
    render(<SourceReader recording={recording} transcript={undefined} onResummarize={vi.fn()} />)
    await waitFor(() => {}, { timeout: 50 })
    expect(isSummaryStale).not.toHaveBeenCalled()
  })

})
