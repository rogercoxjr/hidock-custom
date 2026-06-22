/**
 * SourceReader — "Re-summarize with…" dropdown (Phase 4 / Task 13)
 *
 * Tests that:
 *  (a) the dropdown renders when there are enabled user templates;
 *  (b) the dropdown is absent when there are no user templates (or only builtins);
 *  (c) selecting a template calls resummarizeWithTemplate(recordingId, templateId)
 *      and on success calls onResummarize;
 *  (d) if resummarizeWithTemplate returns { success: false }, toast.error is shown;
 *  (e) dropdown is absent when there is no transcript;
 *  (f) no crash when summarizationTemplates.list IPC is absent.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
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

/**
 * Custom Select mock that:
 * - Renders a <div data-testid="select-root"> wrapper.
 * - Exposes the onValueChange as a data attribute on the trigger button so tests can
 *   fire a simulated selection via a helper <SelectItem> click.
 * - SelectItem renders a <button> labelled with its value — clicking it calls
 *   the captured onValueChange.
 */
let capturedOnValueChange: ((value: string) => void) | undefined
vi.mock('@/components/ui/select', () => ({
  Select: ({ children, onValueChange, disabled }: {
    children: React.ReactNode
    onValueChange?: (value: string) => void
    disabled?: boolean
  }) => {
    capturedOnValueChange = onValueChange
    return <div data-testid="select-root" aria-disabled={disabled}>{children}</div>
  },
  SelectTrigger: ({ children, 'data-testid': dataTestId }: {
    children: React.ReactNode
    'data-testid'?: string
    size?: string
    className?: string
    title?: string
  }) => (
    <button data-testid={dataTestId ?? 'select-trigger'}>{children}</button>
  ),
  SelectValue: ({ placeholder }: { placeholder?: string }) => (
    <span>{placeholder}</span>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <button
      data-testid={`select-item-${value}`}
      onClick={() => capturedOnValueChange?.(value)}
    >
      {children}
    </button>
  ),
}))

vi.mock('../SpeakersPanel', () => ({
  SpeakersPanel: () => <div data-testid="speakers-panel" />,
}))

vi.mock('../TranscriptViewer', () => ({
  TranscriptViewer: () => <div data-testid="transcript-viewer" />,
}))

// --- Helpers ---------------------------------------------------------------

interface TemplateStub {
  id: string
  name: string
  enabled: boolean
  isBuiltin: boolean
}

function makeElectronAPI(opts: {
  templates?: TemplateStub[]
  resummarizeWithTemplate?: () => Promise<{ success: boolean; error?: string }>
  onResummarize?: () => void
} = {}) {
  const templates = opts.templates ?? [
    { id: 'tpl-1', name: 'Sales', enabled: true, isBuiltin: false },
    { id: 'tpl-2', name: 'Interview', enabled: true, isBuiltin: false },
  ]
  return {
    recordings: {
      selectMeeting: vi.fn().mockResolvedValue({ success: true }),
      getCandidates: vi.fn().mockResolvedValue({ success: true, data: [] }),
      getMeetingsNearDate: vi.fn().mockResolvedValue({ success: true, data: [] }),
      isSummaryStale: vi.fn().mockResolvedValue(false),
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
      list: vi.fn().mockResolvedValue({ success: true, data: templates }),
      latestRun: vi.fn().mockResolvedValue({ success: false }),
      resummarizeWithTemplate:
        opts.resummarizeWithTemplate ?? vi.fn().mockResolvedValue({ success: true }),
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

const transcript: Transcript = {
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
  summarization_template_name: null,
  summarization_template_hash: null,
  created_at: '2026-06-21T10:00:00Z',
}

beforeEach(async () => {
  capturedOnValueChange = undefined
  const { toast } = await import('@/components/ui/toaster')
  vi.mocked(toast.error).mockReset()
  Object.defineProperty(window, 'electronAPI', {
    value: makeElectronAPI(),
    writable: true,
    configurable: true,
  })
})

// --- Tests -----------------------------------------------------------------

describe('SourceReader — Re-summarize with template dropdown', () => {
  it('(a) dropdown trigger renders when there are enabled user templates', async () => {
    const onResummarize = vi.fn()
    render(<SourceReader recording={recording} transcript={transcript} onResummarize={onResummarize} />)

    // After the list IPC resolves, the trigger appears.
    await waitFor(() => {
      expect(screen.getByTestId('resummarize-with-template-trigger')).toBeInTheDocument()
    })
  })

  it('(b) dropdown absent when list returns only builtin templates', async () => {
    Object.defineProperty(window, 'electronAPI', {
      value: makeElectronAPI({
        templates: [
          { id: 'builtin-default', name: 'Default', enabled: true, isBuiltin: true },
        ],
      }),
      writable: true,
      configurable: true,
    })
    const onResummarize = vi.fn()
    render(<SourceReader recording={recording} transcript={transcript} onResummarize={onResummarize} />)

    await waitFor(() => {}, { timeout: 100 })
    expect(screen.queryByTestId('resummarize-with-template-trigger')).not.toBeInTheDocument()
  })

  it('(b2) dropdown absent when list returns no templates', async () => {
    Object.defineProperty(window, 'electronAPI', {
      value: makeElectronAPI({ templates: [] }),
      writable: true,
      configurable: true,
    })
    const onResummarize = vi.fn()
    render(<SourceReader recording={recording} transcript={transcript} onResummarize={onResummarize} />)

    await waitFor(() => {}, { timeout: 100 })
    expect(screen.queryByTestId('resummarize-with-template-trigger')).not.toBeInTheDocument()
  })

  it('(c) selecting a template calls resummarizeWithTemplate and then onResummarize on success', async () => {
    const onResummarize = vi.fn()
    const resummarizeWithTemplate = vi.fn().mockResolvedValue({ success: true })
    Object.defineProperty(window, 'electronAPI', {
      value: makeElectronAPI({ resummarizeWithTemplate }),
      writable: true,
      configurable: true,
    })

    render(<SourceReader recording={recording} transcript={transcript} onResummarize={onResummarize} />)

    // Wait for templates to load and trigger to appear.
    await waitFor(() => {
      expect(screen.getByTestId('resummarize-with-template-trigger')).toBeInTheDocument()
    })

    // Simulate selecting 'tpl-1' via the SelectItem button.
    await act(async () => {
      capturedOnValueChange?.('tpl-1')
    })

    expect(resummarizeWithTemplate).toHaveBeenCalledWith('rec-1', 'tpl-1')
    await waitFor(() => {
      expect(onResummarize).toHaveBeenCalled()
    })
  })

  it('(d) when resummarizeWithTemplate returns { success: false }, toast.error is shown', async () => {
    const onResummarize = vi.fn()
    const resummarizeWithTemplate = vi.fn().mockResolvedValue({
      success: false,
      error: 'transcription in progress',
    })
    Object.defineProperty(window, 'electronAPI', {
      value: makeElectronAPI({ resummarizeWithTemplate }),
      writable: true,
      configurable: true,
    })

    render(<SourceReader recording={recording} transcript={transcript} onResummarize={onResummarize} />)

    await waitFor(() => {
      expect(screen.getByTestId('resummarize-with-template-trigger')).toBeInTheDocument()
    })

    await act(async () => {
      capturedOnValueChange?.('tpl-1')
    })

    expect(resummarizeWithTemplate).toHaveBeenCalledWith('rec-1', 'tpl-1')
    const { toast } = await import('@/components/ui/toaster')
    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        'Re-summarize failed',
        'transcription in progress'
      )
    })
    expect(onResummarize).not.toHaveBeenCalled()
  })

  it('(e) dropdown absent when there is no transcript', async () => {
    const onResummarize = vi.fn()
    render(<SourceReader recording={recording} transcript={undefined} onResummarize={onResummarize} />)

    await waitFor(() => {}, { timeout: 100 })
    expect(screen.queryByTestId('resummarize-with-template-trigger')).not.toBeInTheDocument()
  })

  it('(f) no crash when summarizationTemplates.list IPC is absent', async () => {
    Object.defineProperty(window, 'electronAPI', {
      value: {
        ...makeElectronAPI(),
        summarizationTemplates: { latestRun: vi.fn().mockResolvedValue({ success: false }) },
        // list is absent — no crash expected
      },
      writable: true,
      configurable: true,
    })

    const onResummarize = vi.fn()
    expect(() =>
      render(<SourceReader recording={recording} transcript={transcript} onResummarize={onResummarize} />)
    ).not.toThrow()

    await waitFor(() => {}, { timeout: 100 })
    // No dropdown — no templates loaded.
    expect(screen.queryByTestId('resummarize-with-template-trigger')).not.toBeInTheDocument()
  })
})
