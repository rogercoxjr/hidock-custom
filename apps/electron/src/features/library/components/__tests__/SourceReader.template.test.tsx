/**
 * SourceReader — template chip + suggest-new banner (Phase 3 / Task 13b)
 *
 * Tests that:
 *  (a) chip renders when transcript.summarization_template_name is present;
 *  (b) chip is absent when _name is null/absent;
 *  (c) suggest-new banner renders when latestRun kind === 'suggest_new' and
 *      no higher-priority banner is active;
 *  (d) suggest-new banner is SUPPRESSED when summaryStale banner is visible
 *      (precedence: staleness > suggest-new);
 *  (e) suggest-new banner is SUPPRESSED when error banner is visible
 *      (precedence: error > suggest-new);
 *  (f) latestRun IPC absence / rejection → no crash, chip still renders from _name.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { SourceReader } from '../SourceReader'
import type { UnifiedRecording } from '@/types/unified-recording'
import type { Transcript } from '@/types'

// --- Mocks ----------------------------------------------------------------

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
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('../SpeakersPanel', () => ({
  SpeakersPanel: () => <div data-testid="speakers-panel" />,
}))

vi.mock('../TranscriptViewer', () => ({
  TranscriptViewer: () => <div data-testid="transcript-viewer" />,
}))

// --- Helpers ---------------------------------------------------------------

type LatestRunShape = {
  success: boolean
  data?: {
    name: string | null
    confidence: number | null
    kind: string | null
    suggestedTemplate: Record<string, unknown> | null
    instructionsChanged: boolean
  }
}

function makeElectronAPI(opts: {
  isSummaryStale?: () => Promise<boolean>
  latestRun?: () => Promise<LatestRunShape>
} = {}) {
  return {
    recordings: {
      selectMeeting: vi.fn().mockResolvedValue({ success: true }),
      getCandidates: vi.fn().mockResolvedValue({ success: true, data: [] }),
      getMeetingsNearDate: vi.fn().mockResolvedValue({ success: true, data: [] }),
      isSummaryStale: opts.isSummaryStale ?? vi.fn().mockResolvedValue(false),
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
    summarizationTemplates: {
      latestRun: opts.latestRun ?? vi.fn().mockResolvedValue({ success: false }),
    },
  }
}

const recording: UnifiedRecording = {
  id: 'rec-1',
  filename: 'rec-1.hda',
  title: 'Sales Call',
  location: 'local-only',
  localPath: 'C:/recordings/rec-1.hda',
  transcriptionStatus: 'complete',
  dateRecorded: new Date('2026-06-21T09:00:00Z'),
  size: 2048,
  duration: 120,
} as unknown as UnifiedRecording

/** Build a transcript fixture; name/hash control the template provenance fields. */
function makeTranscript(opts: {
  templateName?: string | null
  templateHash?: string | null
} = {}): Transcript {
  return {
    id: 't1',
    recording_id: 'rec-1',
    full_text: 'Hello this is a transcript',
    language: 'en',
    summary: 'A summary.',
    action_items: null,
    topics: null,
    key_points: null,
    sentiment: null,
    speakers: null,
    word_count: 5,
    transcription_provider: 'assemblyai',
    transcription_model: 'universal-3-pro',
    title_suggestion: 'Sales Call',
    question_suggestions: null,
    summarization_template_name: opts.templateName ?? null,
    summarization_template_hash: opts.templateHash ?? null,
    created_at: '2026-06-21T10:00:00Z',
  }
}

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', {
    value: makeElectronAPI(),
    writable: true,
    configurable: true,
  })
})

// --- Tests -----------------------------------------------------------------

describe('SourceReader template chip', () => {
  it('(a) renders chip when transcript has summarization_template_name', async () => {
    Object.defineProperty(window, 'electronAPI', {
      value: makeElectronAPI({
        latestRun: vi.fn().mockResolvedValue({
          success: true,
          data: { name: 'Sales call', confidence: 0.86, kind: 'applied', suggestedTemplate: null, instructionsChanged: false },
        }),
      }),
      writable: true,
      configurable: true,
    })

    const tx = makeTranscript({ templateName: 'Sales call' })
    render(<SourceReader recording={recording} transcript={tx} />)

    await waitFor(() => {
      expect(screen.getByTestId('template-chip')).toBeInTheDocument()
    })
    expect(screen.getByTestId('template-chip')).toHaveTextContent('Template: Sales call')
  })

  it('(a2) chip includes confidence % from latestRun', async () => {
    Object.defineProperty(window, 'electronAPI', {
      value: makeElectronAPI({
        latestRun: vi.fn().mockResolvedValue({
          success: true,
          data: { name: 'Sales call', confidence: 0.86, kind: 'applied', suggestedTemplate: null, instructionsChanged: false },
        }),
      }),
      writable: true,
      configurable: true,
    })

    const tx = makeTranscript({ templateName: 'Sales call' })
    render(<SourceReader recording={recording} transcript={tx} />)

    // Chip appears immediately from _name; confidence populates after IPC.
    await waitFor(() => {
      expect(screen.getByTestId('template-chip').textContent).toContain('86%')
    })
  })

  it('(b) chip is absent when transcript has no summarization_template_name', async () => {
    const tx = makeTranscript({ templateName: null })
    render(<SourceReader recording={recording} transcript={tx} />)

    await waitFor(() => {}, { timeout: 80 })
    expect(screen.queryByTestId('template-chip')).not.toBeInTheDocument()
  })

  it('(b2) chip is absent when no transcript is provided', async () => {
    render(<SourceReader recording={recording} transcript={undefined} />)
    await waitFor(() => {}, { timeout: 80 })
    expect(screen.queryByTestId('template-chip')).not.toBeInTheDocument()
  })

  it('chip shows instructions-changed hint when latestRun reports instructionsChanged', async () => {
    Object.defineProperty(window, 'electronAPI', {
      value: makeElectronAPI({
        latestRun: vi.fn().mockResolvedValue({
          success: true,
          data: { name: 'Sales call', confidence: 0.9, kind: 'applied', suggestedTemplate: null, instructionsChanged: true },
        }),
      }),
      writable: true,
      configurable: true,
    })

    const tx = makeTranscript({ templateName: 'Sales call', templateHash: 'oldhash' })
    render(<SourceReader recording={recording} transcript={tx} />)

    await waitFor(() => {
      expect(screen.getByTestId('template-instructions-changed')).toBeInTheDocument()
    })
  })
})

describe('SourceReader suggest-new banner', () => {
  it('(c) renders suggest-new banner when kind === suggest_new and no higher-priority banner', async () => {
    Object.defineProperty(window, 'electronAPI', {
      value: makeElectronAPI({
        isSummaryStale: vi.fn().mockResolvedValue(false),
        latestRun: vi.fn().mockResolvedValue({
          success: true,
          data: {
            name: null,
            confidence: 0.3,
            kind: 'suggest_new',
            suggestedTemplate: { name: 'Interview notes' },
            instructionsChanged: false,
          },
        }),
      }),
      writable: true,
      configurable: true,
    })

    const tx = makeTranscript({ templateName: null })
    const completeRecording = { ...recording, transcriptionStatus: 'complete' } as unknown as UnifiedRecording
    render(<SourceReader recording={completeRecording} transcript={tx} />)

    await waitFor(() => {
      expect(screen.getByTestId('suggest-new-banner')).toBeInTheDocument()
    })
    expect(screen.getByText(/Interview notes/i)).toBeInTheDocument()
  })

  it('(d) suggest-new banner SUPPRESSED when summaryStale banner is active (staleness > suggest-new)', async () => {
    Object.defineProperty(window, 'electronAPI', {
      value: makeElectronAPI({
        isSummaryStale: vi.fn().mockResolvedValue(true), // ← stale: higher priority
        latestRun: vi.fn().mockResolvedValue({
          success: true,
          data: {
            name: null,
            confidence: 0.2,
            kind: 'suggest_new',
            suggestedTemplate: { name: 'Interview notes' },
            instructionsChanged: false,
          },
        }),
      }),
      writable: true,
      configurable: true,
    })

    const tx = makeTranscript({ templateName: null })
    render(<SourceReader recording={recording} transcript={tx} onResummarize={vi.fn()} />)

    // Wait for staleness banner to appear.
    await waitFor(() => {
      expect(screen.getByText(/generic speaker labels/i)).toBeInTheDocument()
    })
    // suggest-new must NOT appear.
    expect(screen.queryByTestId('suggest-new-banner')).not.toBeInTheDocument()
  })

  it('(e) suggest-new banner SUPPRESSED when error banner is active (error > suggest-new)', async () => {
    Object.defineProperty(window, 'electronAPI', {
      value: makeElectronAPI({
        isSummaryStale: vi.fn().mockResolvedValue(false),
        latestRun: vi.fn().mockResolvedValue({
          success: true,
          data: {
            name: null,
            confidence: 0.2,
            kind: 'suggest_new',
            suggestedTemplate: { name: 'Interview notes' },
            instructionsChanged: false,
          },
        }),
      }),
      writable: true,
      configurable: true,
    })

    const tx = makeTranscript({ templateName: null })
    // error status → error banner renders.
    const errorRecording = { ...recording, transcriptionStatus: 'error' } as unknown as UnifiedRecording
    render(<SourceReader recording={errorRecording} transcript={tx} onResummarize={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText(/summary failed/i)).toBeInTheDocument()
    })
    expect(screen.queryByTestId('suggest-new-banner')).not.toBeInTheDocument()
  })

  it('(f) no crash when latestRun IPC is absent; chip still renders from _name', async () => {
    Object.defineProperty(window, 'electronAPI', {
      value: {
        ...makeElectronAPI(),
        summarizationTemplates: undefined, // ← IPC not wired
      },
      writable: true,
      configurable: true,
    })

    const tx = makeTranscript({ templateName: 'Sales call' })
    // Should NOT throw.
    expect(() => render(<SourceReader recording={recording} transcript={tx} />)).not.toThrow()

    // Chip renders from the transcript's _name field (no IPC needed for the name).
    await waitFor(() => {
      expect(screen.getByTestId('template-chip')).toBeInTheDocument()
    })
  })

  it('(f2) no crash when latestRun IPC rejects', async () => {
    Object.defineProperty(window, 'electronAPI', {
      value: makeElectronAPI({
        latestRun: vi.fn().mockRejectedValue(new Error('IPC error')),
      }),
      writable: true,
      configurable: true,
    })

    const tx = makeTranscript({ templateName: 'Demo' })
    expect(() => render(<SourceReader recording={recording} transcript={tx} />)).not.toThrow()

    // Chip still renders; latestRun → null after rejection (no confidence, no banner).
    await waitFor(() => {
      expect(screen.getByTestId('template-chip')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('suggest-new-banner')).not.toBeInTheDocument()
  })
})
