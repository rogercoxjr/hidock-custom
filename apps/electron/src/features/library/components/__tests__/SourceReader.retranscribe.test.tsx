/**
 * SourceReader re-transcribe confirmation dialog (spec §6.8 / AC6, D5-T5)
 *
 * Covers the four AC6 acceptance criteria:
 *  (a) clicking transcribe on an ALREADY-transcribed recording shows the
 *      confirmation and does NOT immediately call onTranscribe;
 *  (b) confirming calls onTranscribe;
 *  (c) cancelling does NOT call onTranscribe;
 *  (d) first-time transcribe (no transcript) calls onTranscribe directly
 *      with no confirmation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
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

// Controllable ConfirmDialog stub: exposes Confirm / Cancel buttons when open.
vi.mock('@/components/ConfirmDialog', () => ({
  ConfirmDialog: ({
    open, onConfirm, onOpenChange, title, description
  }: { open: boolean; onConfirm: () => void; onOpenChange: (o: boolean) => void; title: string; description: string }) => {
    if (!open) return null
    return (
      <div data-testid="confirm-dialog">
        <p>{title}</p>
        <p>{description}</p>
        <button onClick={() => { onConfirm(); onOpenChange(false) }}>Confirm Action</button>
        <button onClick={() => onOpenChange(false)}>Cancel Action</button>
      </div>
    )
  },
}))

const isSummaryStale = vi.fn().mockResolvedValue(false)
beforeEach(() => {
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    recordings: { isSummaryStale }
  }
})

const recording = {
  id: 'rec-1', filename: 'rec-1.hda', title: 'Standup', location: 'local-only',
  localPath: 'C:/recordings/rec-1.hda', transcriptionStatus: 'complete',
  dateRecorded: new Date('2026-06-17T09:00:00Z'), size: 1024, duration: 60
} as unknown as UnifiedRecording

const transcript = {
  id: 't1', recording_id: 'rec-1', full_text: 'hello world', language: 'en',
  summary: 'S', action_items: null, topics: null, key_points: null, sentiment: null,
  speakers: null, word_count: 2, transcription_provider: 'assemblyai',
  transcription_model: 'universal-3-pro', title_suggestion: 'Standup',
  question_suggestions: null, created_at: '2026-06-17T10:00:00Z'
} as Transcript

describe('SourceReader re-transcribe confirmation (spec §6.8 / AC6)', () => {
  it('shows the confirmation dialog and calls onTranscribe ONLY on confirm', async () => {
    const onTranscribe = vi.fn()
    render(<SourceReader recording={recording} transcript={transcript} onTranscribe={onTranscribe} onResummarize={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /re-transcribe/i }))
    expect(await screen.findByTestId('confirm-dialog')).toBeInTheDocument()
    expect(screen.getByText(/replaces the current transcript and its speaker mappings/i)).toBeInTheDocument()
    expect(onTranscribe).not.toHaveBeenCalled() // not yet — just opened

    fireEvent.click(screen.getByRole('button', { name: /confirm action/i }))
    expect(onTranscribe).toHaveBeenCalledTimes(1)
    // AC6 live-wiring: confirm must force a re-queue so a COMPLETE recording
    // bypasses queueTranscription's complete-guard and reaches recordings:transcribe.
    expect(onTranscribe).toHaveBeenCalledWith(true)
  })

  it('cancel does nothing (onTranscribe not called)', async () => {
    const onTranscribe = vi.fn()
    render(<SourceReader recording={recording} transcript={transcript} onTranscribe={onTranscribe} onResummarize={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /re-transcribe/i }))
    await screen.findByTestId('confirm-dialog')
    fireEvent.click(screen.getByRole('button', { name: /cancel action/i }))

    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument())
    expect(onTranscribe).not.toHaveBeenCalled()
  })

  it('first-time transcribe (no transcript) calls onTranscribe directly — no dialog', () => {
    const onTranscribe = vi.fn()
    const firstTimeRecording = {
      id: 'rec-2', filename: 'rec-2.hda', title: 'First', location: 'local-only',
      localPath: 'C:/recordings/rec-2.hda', transcriptionStatus: 'none',
      dateRecorded: new Date('2026-06-17T09:00:00Z'), size: 1024, duration: 60
    } as unknown as UnifiedRecording
    render(<SourceReader recording={firstTimeRecording} transcript={undefined} onTranscribe={onTranscribe} onResummarize={vi.fn()} />)

    // No Re-transcribe button — only the regular Transcribe button.
    // Tight selector so it can't accidentally match "Re-transcribe".
    expect(screen.queryByRole('button', { name: /re-transcribe/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^transcribe$/i }))
    // First-time transcribe is NOT forced (no transcript to overwrite).
    expect(onTranscribe).toHaveBeenCalledTimes(1)
    expect(onTranscribe).toHaveBeenCalledWith(false)
    expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument()
  })

  it('no double button: an already-transcribed recording shows Re-transcribe but NOT first-time Transcribe', () => {
    const onTranscribe = vi.fn()
    // full_text present but status not 'complete' (e.g. summary failed → 'error') —
    // the prior overlap bug rendered BOTH buttons in this state.
    const errored = {
      id: 'rec-3', filename: 'rec-3.hda', title: 'Errored', location: 'local-only',
      localPath: 'C:/recordings/rec-3.hda', transcriptionStatus: 'error',
      dateRecorded: new Date('2026-06-17T09:00:00Z'), size: 1024, duration: 60
    } as unknown as UnifiedRecording
    render(<SourceReader recording={errored} transcript={transcript} onTranscribe={onTranscribe} onResummarize={vi.fn()} />)

    expect(screen.getByRole('button', { name: /re-transcribe/i })).toBeInTheDocument()
    // Exactly one transcribe-family button (Re-transcribe), no bare "Transcribe".
    expect(screen.queryByRole('button', { name: /^transcribe$/i })).not.toBeInTheDocument()
  })
})
