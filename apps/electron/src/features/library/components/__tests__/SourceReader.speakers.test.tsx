/**
 * SourceReader — diarization wiring (D3-T4 Fix 1, live path)
 *
 * SourceReader is the LIVE host of the diarization UI (Library.tsx -> SourceReader ->
 * TranscriptViewer + SpeakersPanel).
 *
 * Asserts:
 *  - when the transcript carries structured `turns`, SourceReader parses them,
 *    fetches the speaker->contact name map (speakers:getForRecording), and renders
 *    BOTH the SpeakersPanel (turns + assignedNames) and a STRUCTURED TranscriptViewer
 *    (turns + speakerNames);
 *  - panel onChanged re-fetches BOTH turns (transcripts:getByRecordingId) and names
 *    so the view updates live;
 *  - absent turns -> NO SpeakersPanel and the TranscriptViewer receives no turns
 *    (legacy text-prefix fallback).
 *
 * SpeakersPanel + TranscriptViewer are stubbed to lightweight prop-capturing surfaces.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SourceReader } from '../SourceReader'
import type { UnifiedRecording } from '@/types/unified-recording'
import type { Meeting, Transcript } from '@/types'

// --- Mocks ---------------------------------------------------------------

vi.mock('@radix-ui/react-portal', () => ({
  Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@/components/ui/toaster', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))

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
  Select: ({ children }: any) => <div>{children}</div>,
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: any) => <>{children}</>,
  SelectItem: ({ children }: any) => <div>{children}</div>,
}))

// Stub SpeakersPanel: surface received props + a button to fire onChanged.
vi.mock('../SpeakersPanel', () => ({
  SpeakersPanel: ({
    turns,
    assignedNames,
    suggestions,
    onChanged,
  }: {
    turns: Array<{ speaker: string }>
    assignedNames?: Record<string, string>
    suggestions?: Array<unknown>
    onChanged: () => void
  }) => (
    <div data-testid="speakers-panel">
      <div data-testid="panel-turn-count">{turns.length}</div>
      <div data-testid="panel-assigned-names">{JSON.stringify(assignedNames ?? {})}</div>
      <div data-testid="panel-suggestion-count">{suggestions?.length ?? 0}</div>
      <button onClick={onChanged}>fire onChanged</button>
    </div>
  ),
}))

// Stub TranscriptViewer: surface whether structured turns + speakerNames arrive.
vi.mock('../TranscriptViewer', () => ({
  TranscriptViewer: ({
    turns,
    speakerNames,
  }: {
    turns?: Array<{ speaker: string }>
    speakerNames?: Record<string, string>
  }) => (
    <div data-testid="transcript-viewer">
      <div data-testid="tv-has-turns">{turns ? 'yes' : 'no'}</div>
      <div data-testid="tv-turn-count">{turns?.length ?? 0}</div>
      <div data-testid="tv-speaker-names">{JSON.stringify(speakerNames ?? {})}</div>
    </div>
  ),
}))

const mockGetForRecording = vi.fn()
const mockGetByRecordingId = vi.fn()
const mockGetSuggestions = vi.fn()

const baseRecording: UnifiedRecording = {
  id: 'rec-1',
  filename: 'meeting.hda',
  size: 1024,
  duration: 60,
  dateRecorded: new Date('2026-06-17T10:00:00Z'),
  transcriptionStatus: 'complete',
  location: 'local-only',
  localPath: '/tmp/meeting.hda',
  syncStatus: 'synced',
} as UnifiedRecording

function makeMeeting(): Meeting {
  return {
    id: 'meet-1',
    subject: 'Team Standup',
    start_time: '2026-06-17T09:00:00Z',
    end_time: '2026-06-17T09:30:00Z',
  } as Meeting
}

type FixtureTurn = { speaker: string; startMs: number; endMs: number; text: string }

function makeTranscript(turns?: FixtureTurn[]): Transcript {
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
    ...(turns ? { turns: JSON.stringify(turns) } : {}),
    word_count: 1,
    transcription_provider: 'assemblyai',
    transcription_model: 'universal-3-pro',
    title_suggestion: null,
    question_suggestions: null,
    created_at: '2026-06-17T10:00:00Z',
  } as unknown as Transcript
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetForRecording.mockResolvedValue({
    success: true,
    data: { A: { contactId: 'cA', contactName: 'Alice' }, B: { contactId: 'cB', contactName: 'Bob' } },
  })
  mockGetByRecordingId.mockResolvedValue(
    makeTranscript([
      { speaker: 'A', startMs: 0, endMs: 1000, text: 'hi' },
      { speaker: 'B', startMs: 1000, endMs: 2000, text: 'yo' },
    ])
  )
  // Default: no pending suggestions (keeps existing tests unaffected).
  mockGetSuggestions.mockResolvedValue({ success: true, data: [] })
  Object.defineProperty(window, 'electronAPI', {
    value: {
      knowledge: { update: vi.fn().mockResolvedValue({ success: true }) },
      recordings: { selectMeeting: vi.fn().mockResolvedValue({ success: true }) },
      storage: { getInfo: vi.fn() },
      speakers: { getForRecording: mockGetForRecording, getSuggestions: mockGetSuggestions },
      transcripts: { getByRecordingId: mockGetByRecordingId },
    },
    writable: true,
    configurable: true,
  })
})

describe('SourceReader — diarization wiring (D3-T4 Fix 1)', () => {
  it('renders SpeakersPanel + structured TranscriptViewer when the transcript has turns', async () => {
    const transcript = makeTranscript([
      { speaker: 'A', startMs: 0, endMs: 1000, text: 'hi' },
      { speaker: 'B', startMs: 1000, endMs: 2000, text: 'yo' },
    ])
    render(<SourceReader recording={baseRecording} transcript={transcript} meeting={makeMeeting()} onSeek={vi.fn()} />)

    // SpeakersPanel mounts with the parsed turns.
    await waitFor(() => expect(screen.getByTestId('speakers-panel')).toBeInTheDocument())
    expect(screen.getByTestId('panel-turn-count').textContent).toBe('2')

    // TranscriptViewer receives structured turns.
    expect(screen.getByTestId('tv-has-turns').textContent).toBe('yes')
    expect(screen.getByTestId('tv-turn-count').textContent).toBe('2')
  })

  // Regression: matcher suggestions must NOT flash-then-vanish when the parent's
  // batched transcript fetch resolves and the `transcript` prop flips undefined->object
  // while recordingId is unchanged. (Root cause: the prop-seeding effect blanked
  // suggestions on every transcriptTurns change.)
  it('keeps suggestions visible when the transcript prop churns at a stable recording (no flicker)', async () => {
    mockGetSuggestions.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'sug-1',
          kind: 'identity',
          targetLabel: 'A',
          targetLabel2: null,
          contactId: 'c-x',
          contactName: 'Xavier',
          contactName2: null,
          score: 0.8,
          rank: 1,
          rationale: 'strong',
          requiresWarning: false,
        },
      ],
    })

    // Transcript present (panel rendered); suggestion loads.
    const { rerender } = render(
      <SourceReader
        recording={baseRecording}
        transcript={makeTranscript([{ speaker: 'A', startMs: 0, endMs: 1000, text: 'hi' }])}
        onSeek={vi.fn()}
      />
    )
    await waitFor(() => expect(screen.getByTestId('panel-suggestion-count').textContent).toBe('1'))

    // Parent re-issues the transcript with a CHANGED turns string (e.g. Map rebuild /
    // enrichment), recordingId unchanged. The buggy seed effect blanked suggestions
    // synchronously on this change -> the flash-then-vanish.
    rerender(
      <SourceReader
        recording={baseRecording}
        transcript={makeTranscript([
          { speaker: 'A', startMs: 0, endMs: 1000, text: 'hi' },
          { speaker: 'B', startMs: 1000, endMs: 2000, text: 'there' },
        ])}
        onSeek={vi.fn()}
      />
    )

    // No empty window: suggestion stays visible across the prop churn (buggy = '0' here).
    expect(screen.getByTestId('panel-suggestion-count').textContent).toBe('1')
    await waitFor(() => expect(screen.getByTestId('panel-suggestion-count').textContent).toBe('1'))
  })

  // Switching to a different recording MUST clear the previous recording's suggestions.
  it('clears suggestions when the recording changes', async () => {
    mockGetSuggestions.mockResolvedValue({
      success: true,
      data: [
        { id: 'sug-1', kind: 'identity', targetLabel: 'A', targetLabel2: null, contactId: 'c-x',
          contactName: 'Xavier', contactName2: null, score: 0.8, rank: 1, rationale: 'strong', requiresWarning: false },
      ],
    })
    const { rerender } = render(
      <SourceReader recording={baseRecording} transcript={makeTranscript([{ speaker: 'A', startMs: 0, endMs: 1000, text: 'hi' }])} onSeek={vi.fn()} />
    )
    await waitFor(() => expect(screen.getByTestId('panel-suggestion-count').textContent).toBe('1'))

    // Different recording with no suggestions.
    mockGetSuggestions.mockResolvedValue({ success: true, data: [] })
    const other = { ...baseRecording, id: 'rec-2' } as UnifiedRecording
    rerender(<SourceReader recording={other} transcript={makeTranscript([{ speaker: 'A', startMs: 0, endMs: 1000, text: 'hi' }])} onSeek={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('panel-suggestion-count').textContent).toBe('0'))
  })

  it('fetches the speaker->contact name map and passes it as speakerNames + assignedNames', async () => {
    const transcript = makeTranscript([{ speaker: 'A', startMs: 0, endMs: 1000, text: 'hi' }])
    render(<SourceReader recording={baseRecording} transcript={transcript} onSeek={vi.fn()} />)

    await waitFor(() => expect(mockGetForRecording).toHaveBeenCalledWith('rec-1'))
    // Both the panel and the viewer get the derived names.
    await waitFor(() =>
      expect(screen.getByTestId('panel-assigned-names').textContent).toBe(
        JSON.stringify({ A: 'Alice', B: 'Bob' })
      )
    )
    expect(screen.getByTestId('tv-speaker-names').textContent).toBe(JSON.stringify({ A: 'Alice', B: 'Bob' }))
  })

  it('re-fetches turns + names when the panel reports a change (live refresh)', async () => {
    const transcript = makeTranscript([{ speaker: 'A', startMs: 0, endMs: 1000, text: 'hi' }])
    render(<SourceReader recording={baseRecording} transcript={transcript} onSeek={vi.fn()} />)

    await waitFor(() =>
      expect(screen.getByTestId('panel-assigned-names').textContent).toBe(
        JSON.stringify({ A: 'Alice', B: 'Bob' })
      )
    )

    // After an edit: next fetches return updated data (renamed + extra turn).
    mockGetForRecording.mockResolvedValue({
      success: true,
      data: { A: { contactId: 'cA', contactName: 'Alice Renamed' } },
    })
    mockGetByRecordingId.mockResolvedValue(
      makeTranscript([
        { speaker: 'A', startMs: 0, endMs: 1000, text: 'hi' },
        { speaker: 'A', startMs: 1000, endMs: 2000, text: 'again' },
      ])
    )

    fireEvent.click(screen.getByText('fire onChanged'))

    await waitFor(() => expect(mockGetByRecordingId).toHaveBeenCalledWith('rec-1'))
    await waitFor(() =>
      expect(screen.getByTestId('panel-assigned-names').textContent).toBe(JSON.stringify({ A: 'Alice Renamed' }))
    )
    await waitFor(() => expect(screen.getByTestId('panel-turn-count').textContent).toBe('2'))
    expect(mockGetForRecording.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('REGRESSION: no turns -> no SpeakersPanel and TranscriptViewer gets no turns (legacy fallback)', async () => {
    // No turns anywhere: prop transcript AND the live refetch both lack turns.
    mockGetByRecordingId.mockResolvedValue(makeTranscript())
    mockGetForRecording.mockResolvedValue({ success: true, data: {} })
    const transcript = makeTranscript() // no `turns`
    render(<SourceReader recording={baseRecording} transcript={transcript} onSeek={vi.fn()} />)

    // Let the async refresh settle, then assert the legacy (no-structured) path.
    await waitFor(() => expect(mockGetByRecordingId).toHaveBeenCalledWith('rec-1'))

    await waitFor(() => expect(screen.getByTestId('transcript-viewer')).toBeInTheDocument())
    expect(screen.queryByTestId('speakers-panel')).not.toBeInTheDocument()
    expect(screen.getByTestId('tv-has-turns').textContent).toBe('no')
    // No structured speaker name map is fetched/passed.
    expect(screen.getByTestId('tv-speaker-names').textContent).toBe(JSON.stringify({}))
  })
})
