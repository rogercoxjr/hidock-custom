import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { SourceReader } from '../SourceReader'
import type { UnifiedRecording } from '@/types/unified-recording'

// Capture each Select's onValueChange, tagging the one that owns the export items so we
// can find it WITHOUT relying on render order (a Re-summarize Select may also render).
// The mocked SelectTrigger forwards data-testid; the export trigger is
// data-testid="transcript-export-trigger", so the Select wrapping it is the export one.
const selectCalls: Array<{ onValueChange?: (v: string) => void; isExport: boolean }> = []
function subtreeHasTestId(node: any, testId: string): boolean {
  if (!node || typeof node !== 'object') return false
  const arr = Array.isArray(node) ? node : [node]
  for (const n of arr) {
    if (!n || typeof n !== 'object') continue
    if (n.props?.['data-testid'] === testId) return true
    if (n.props?.children && subtreeHasTestId(n.props.children, testId)) return true
  }
  return false
}
vi.mock('@/components/ui/select', () => ({
  Select: ({ children, onValueChange }: any) => {
    const isExport = subtreeHasTestId(children, 'transcript-export-trigger')
    selectCalls.push({ onValueChange, isExport })
    return <div data-testid={isExport ? 'export-select' : 'select'}>{children}</div>
  },
  SelectTrigger: ({ children, ['data-testid']: testId }: any) => (
    <button data-testid={testId}>{children}</button>
  ),
  SelectValue: ({ placeholder }: any) => <span>{placeholder}</span>,
  SelectContent: ({ children }: any) => <div>{children}</div>,
  SelectItem: ({ children, value, disabled }: any) => (
    <div data-testid={`item-${value}`} data-disabled={disabled ? 'true' : 'false'}>{children}</div>
  )
}))

const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('@/components/ui/toaster', () => ({
  toast: { error: (...a: any[]) => toastError(...a), success: (...a: any[]) => toastSuccess(...a) }
}))

const recording = {
  id: 'rec1',
  filename: 'rec1.wav',
  transcriptionStatus: 'complete',
  location: 'local-only',
  localPath: 'C:/recordings/rec1.wav',
  title: 'Test Recording',
  dateRecorded: new Date('2026-06-01T10:00:00Z'),
  size: 1024,
  duration: 60
} as unknown as UnifiedRecording

const diarizedTranscript = {
  full_text: 'Hi there',
  turns: JSON.stringify([{ speaker: 'Speaker_0', startMs: 0, endMs: 1000, text: 'Hi' }])
} as any

const nonDiarizedTranscript = { full_text: 'Hi there', turns: null } as any

// IMPORTANT: window.electronAPI.transcripts.getByRecordingId returns a RAW Transcript
// (the db:get-transcript channel), NOT a Result envelope. SourceReader.refreshSpeakers
// reads `freshTranscript.turns` (a raw JSON string) directly. If we mocked an envelope
// here, `.turns` would be undefined and the async setTurns([]) would blank the
// prop-seeded turns and race the gating assertions. So the mock must mirror the prop.
const getByRecordingId = vi.fn()
const exportFn = vi.fn()

/** Render with getByRecordingId mirroring the given raw transcript prop. */
function renderWith(transcript: any) {
  getByRecordingId.mockResolvedValue(transcript) // raw Transcript, not a Result
  return render(<SourceReader recording={recording} transcript={transcript} onResummarize={vi.fn()} />)
}

beforeEach(() => {
  selectCalls.length = 0
  toastError.mockReset()
  toastSuccess.mockReset()
  exportFn.mockReset()
  getByRecordingId.mockReset()
  Object.defineProperty(window, 'electronAPI', {
    value: {
      transcripts: {
        getByRecordingId: (...a: any[]) => getByRecordingId(...a),
        export: exportFn
      },
      speakers: {
        getForRecording: vi.fn().mockResolvedValue({ success: true, data: {} }),
        getSuggestions: vi.fn().mockResolvedValue({ success: true, data: [] })
      },
      contacts: { getAll: vi.fn().mockResolvedValue({ success: true, data: { contacts: [] } }) },
      recordings: { isSummaryStale: vi.fn().mockResolvedValue(false) },
      summarizationTemplates: { list: vi.fn().mockResolvedValue({ success: true, data: [] }) },
      onVoiceprintCaptured: vi.fn().mockReturnValue(() => {/* unsubscribe noop */})
    },
    writable: true,
    configurable: true,
  })
})

/**
 * Return the export Select's captured props, identified deterministically by the
 * `transcript-export-trigger` testid it wraps — NOT by positional last-Select (a
 * Re-summarize Select may also render after it).
 */
function findExportSelect() {
  expect(screen.getByTestId('item-json')).toBeTruthy()
  const exportSelect = selectCalls.find((c) => c.isExport)
  expect(exportSelect).toBeTruthy()
  return exportSelect!
}

describe('SourceReader export dropdown', () => {
  it('disables CSV and SRT for a non-diarized transcript; JSON stays enabled', async () => {
    renderWith(nonDiarizedTranscript)
    // Wait for the async refreshSpeakers to settle (it sets turns from the raw fetch).
    await waitFor(() => expect(screen.getByTestId('item-csv').getAttribute('data-disabled')).toBe('true'))
    expect(screen.getByTestId('item-json').getAttribute('data-disabled')).toBe('false')
    expect(screen.getByTestId('item-srt').getAttribute('data-disabled')).toBe('true')
  })

  it('enables CSV and SRT for a diarized transcript', async () => {
    renderWith(diarizedTranscript)
    await waitFor(() => expect(screen.getByTestId('item-csv').getAttribute('data-disabled')).toBe('false'))
    expect(screen.getByTestId('item-srt').getAttribute('data-disabled')).toBe('false')
    expect(screen.getByTestId('item-json').getAttribute('data-disabled')).toBe('false')
  })

  it('calls transcripts.export with the recordingId and chosen format, toasting the saved path', async () => {
    exportFn.mockResolvedValue({ success: true, data: '/out/My Meeting.json' })
    renderWith(diarizedTranscript)
    await waitFor(() => expect(screen.getByTestId('item-json')).toBeTruthy())
    const sel = findExportSelect()
    await sel.onValueChange!('json')
    expect(exportFn).toHaveBeenCalledWith('rec1', 'json')
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
  })

  it('is a no-op on cancellation (data === null): no toast', async () => {
    exportFn.mockResolvedValue({ success: true, data: null })
    renderWith(diarizedTranscript)
    await waitFor(() => expect(screen.getByTestId('item-json')).toBeTruthy())
    const sel = findExportSelect()
    await sel.onValueChange!('json')
    expect(exportFn).toHaveBeenCalledWith('rec1', 'json')
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })

  it('shows an error toast when the export fails', async () => {
    exportFn.mockResolvedValue({ success: false, error: { code: 'INTERNAL_ERROR', message: 'disk full' } })
    renderWith(diarizedTranscript)
    await waitFor(() => expect(screen.getByTestId('item-json')).toBeTruthy())
    const sel = findExportSelect()
    await sel.onValueChange!('json')
    await waitFor(() => expect(toastError).toHaveBeenCalled())
  })
})
