import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SourceReader } from '../SourceReader'
import type { UnifiedRecording } from '@/types/unified-recording'
import type { Transcript } from '@/types'

vi.mock('@radix-ui/react-portal', () => ({
  Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('@/components/ui/toaster', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))
vi.mock('@/components/AudioPlayer', () => ({ AudioPlayer: () => <div data-testid="audio-player" /> }))
vi.mock('@/components/RecordingLinkDialog', () => ({ RecordingLinkDialog: () => null }))
vi.mock('@/components/ConfirmDialog', () => ({ ConfirmDialog: () => null }))
vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: any) => <div>{children}</div>,
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: any) => <>{children}</>,
  SelectItem: ({ children }: any) => <div>{children}</div>,
}))
vi.mock('../SpeakersPanel', () => ({
  SpeakersPanel: () => <div data-testid="speakers-panel" />,
}))
vi.mock('../TranscriptViewer', () => ({
  TranscriptViewer: ({ summary }: { summary?: string }) => (
    <div data-testid="transcript-viewer">
      <div data-testid="tv-summary-prop">{summary ?? 'NONE'}</div>
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

function makeTranscript(over: Partial<Transcript> = {}): Transcript {
  return {
    id: 't-1',
    recording_id: 'rec-1',
    full_text: 'Some transcript body.',
    summary: 'This is the summary.',
    action_items: null,
    turns: JSON.stringify([{ speaker: 'A', startMs: 0, endMs: 4000, text: 'Hi.' }]),
    ...over,
  } as Transcript
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetForRecording.mockResolvedValue({ success: true, data: {} })
  mockGetByRecordingId.mockResolvedValue(makeTranscript())
  mockGetSuggestions.mockResolvedValue({ success: true, data: [] })
  Object.defineProperty(window, 'electronAPI', {
    value: {
      speakers: { getForRecording: mockGetForRecording, getSuggestions: mockGetSuggestions },
      transcripts: { getByRecordingId: mockGetByRecordingId },
      recordings: { isSummaryStale: vi.fn().mockResolvedValue(false) },
      summarizationTemplates: {
        latestRun: vi.fn().mockResolvedValue({ success: false }),
        list: vi.fn().mockResolvedValue({ success: true, data: [] }),
      },
    },
    writable: true,
    configurable: true,
  })
})

describe('SourceReader — summary at top (QOL #5)', () => {
  it('renders the summary block above the SpeakersPanel and does NOT pass summary to TranscriptViewer', async () => {
    render(<SourceReader recording={baseRecording} transcript={makeTranscript()} />)
    const summary = await screen.findByText('This is the summary.')
    expect(summary).toBeInTheDocument()
    // header present
    expect(screen.getByText('Summary')).toBeInTheDocument()
    // ordering: summary appears before BOTH the speakers panel and the transcript viewer
    // (spec places the summary above SpeakersPanel AND TranscriptViewer — assert both so an
    //  implementer cannot wedge the summary between the two and still pass).
    const panel = await screen.findByTestId('speakers-panel')
    const viewer = await screen.findByTestId('transcript-viewer')
    expect(summary.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(summary.compareDocumentPosition(viewer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // TranscriptViewer no longer receives a summary
    expect(screen.getByTestId('tv-summary-prop')).toHaveTextContent('NONE')
  })

  it('renders no Summary block when the transcript has no summary', async () => {
    render(<SourceReader recording={baseRecording} transcript={makeTranscript({ summary: null })} />)
    await screen.findByTestId('transcript-viewer')
    expect(screen.queryByText('Summary')).not.toBeInTheDocument()
  })

  it('renders the summary as formatted markdown (headings/lists), not literal markup', async () => {
    render(
      <SourceReader
        recording={baseRecording}
        transcript={makeTranscript({ summary: '## Decisions\n\n- ship it\n- follow up' })}
      />
    )
    const heading = await screen.findByText('Decisions')
    expect(heading.tagName).toBe('H2')
    expect(screen.getByText('ship it').closest('li')).toBeTruthy()
    // not rendered as literal markdown text
    expect(screen.queryByText('## Decisions')).not.toBeInTheDocument()
  })
})
