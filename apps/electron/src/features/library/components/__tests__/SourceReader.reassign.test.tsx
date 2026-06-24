import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SourceReader } from '../SourceReader'
import { useConfigStore } from '@/store/domain/useConfigStore'
import type { UnifiedRecording } from '@/types/unified-recording'

vi.mock('@/components/ui/toaster', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))
vi.mock('@/components/AudioPlayer', () => ({ AudioPlayer: () => null }))

const TURNS = [
  { speaker: 'A', startMs: 0, endMs: 4000, text: 'Alpha one.' },
  { speaker: 'B', startMs: 4000, endMs: 8000, text: 'Bravo one.' },
  { speaker: 'A', startMs: 8000, endMs: 12000, text: 'Alpha two.' },
]

const reassignTurns = vi.fn().mockResolvedValue({
  success: true,
  data: { recordingId: 'rec-1', targetLabel: 'B', rewrittenCount: 1 },
})
const getSuggestions = vi.fn().mockResolvedValue({ success: true, data: [] })

function recording(): UnifiedRecording {
  return {
    id: 'rec-1', filename: 'r.wav', title: 'R', location: 'local', transcriptionStatus: 'complete',
    dateRecorded: new Date().toISOString(),
  } as unknown as UnifiedRecording
}

beforeEach(() => {
  vi.clearAllMocks()
  useConfigStore.setState({
    config: { privacy: { enableVoiceprintCapture: false } } as unknown as import('@/types').AppConfig,
  })
  Object.defineProperty(window, 'electronAPI', {
    value: {
      transcripts: {
        getByRecordingId: vi.fn().mockResolvedValue({ turns: JSON.stringify(TURNS), full_text: 'x' }),
      },
      speakers: {
        getForRecording: vi.fn().mockResolvedValue({ success: true, data: {} }),
        getSuggestions,
        reassignTurns,
      },
      contacts: {
        getForMeeting: vi.fn().mockResolvedValue({ success: true, data: [] }),
        getAll: vi.fn().mockResolvedValue({ success: true, data: { contacts: [], total: 0 } }),
        create: vi.fn(),
      },
      recordings: { isSummaryStale: vi.fn().mockResolvedValue(false) },
      summarizationTemplates: {
        latestRun: vi.fn().mockResolvedValue({ success: false }),
        list: vi.fn().mockResolvedValue({ success: true, data: [] }),
      },
      onVoiceprintCaptured: vi.fn(() => vi.fn()),
    },
    writable: true,
    configurable: true,
  })
})

describe('SourceReader — reassign wiring', () => {
  it('reassigning a by-speaker turn calls speakers.reassignTurns then refreshes (getSuggestions runs again)', async () => {
    render(
      <SourceReader
        recording={recording()}
        transcript={{ full_text: 'x', turns: JSON.stringify(TURNS) } as any}
        onSeek={vi.fn()}
      />
    )
    // Switch the transcript to By-speaker and open the reassign menu on the first A turn.
    fireEvent.click(await screen.findByRole('tab', { name: /by speaker/i }))
    fireEvent.click(screen.getAllByRole('button', { name: /^reassign turn/i })[0])
    fireEvent.click(await screen.findByRole('button', { name: /^reassign$/i }))
    fireEvent.click(await screen.findByRole('button', { name: /reassign to speaker b/i }))

    await waitFor(() =>
      expect(reassignTurns).toHaveBeenCalledWith({
        recordingId: 'rec-1',
        sourceLabel: 'A',
        anchorIndex: 0,
        anchorStartMs: 0,
        scope: 'one',
        target: { kind: 'existingLabel', label: 'B' },
      })
    )
    // refreshSpeakers re-runs getSuggestions (initial mount call + post-reassign call).
    await waitFor(() => expect(getSuggestions.mock.calls.length).toBeGreaterThanOrEqual(2))
  })

  it('reassigning the SECOND A turn threads the correct NON-ZERO global anchorIndex/startMs', async () => {
    // TURNS: A@0 (idx 0), B@4000 (idx 1), A@8000 (idx 2). The second A turn is global index 2.
    // This guards against passing the within-speaker-group index (j=1) instead of the global
    // turns index (i=2) — a bug the index-0 test above cannot catch.
    render(
      <SourceReader
        recording={recording()}
        transcript={{ full_text: 'x', turns: JSON.stringify(TURNS) } as any}
        onSeek={vi.fn()}
      />
    )
    fireEvent.click(await screen.findByRole('tab', { name: /by speaker/i }))
    // The second A turn lives in speaker A's card; open its reassign menu via the turn row.
    fireEvent.click(
      screen
        .getByText('Alpha two.')
        .closest('[data-testid="by-speaker-turn"]')!
        .querySelector('button[aria-label^="Reassign turn"]')! as HTMLElement
    )
    fireEvent.click(await screen.findByRole('button', { name: /reassign all before/i }))
    fireEvent.click(await screen.findByRole('button', { name: /reassign to speaker b/i }))

    await waitFor(() =>
      expect(reassignTurns).toHaveBeenCalledWith({
        recordingId: 'rec-1',
        sourceLabel: 'A',
        anchorIndex: 2,
        anchorStartMs: 8000,
        scope: 'before',
        target: { kind: 'existingLabel', label: 'B' },
      })
    )
  })
})
