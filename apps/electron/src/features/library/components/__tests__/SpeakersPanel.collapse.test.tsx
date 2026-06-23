import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SpeakersPanel } from '../SpeakersPanel'
import { setupSpeakersPanelMocks, makeTurns } from './speakersPanelTestUtils'

vi.mock('@/components/ui/toaster', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  setupSpeakersPanelMocks()
})

describe('SpeakersPanel — collapsible panel (QOL #3)', () => {
  it('shows the body by default, hides it after toggling, keeps the header', async () => {
    render(
      <SpeakersPanel
        recordingId="rec-1"
        meetingId="meet-1"
        turns={makeTurns()}
        // Pass an assigned speaker so this collapse test also smoke-exercises the
        // Task-5 resolveName path (a crash in resolveName would surface here too).
        assignedSpeakers={{ A: { contactId: 'c-1', contactName: 'Alice' } }}
        assignedNames={{ A: 'Alice' }}
        onChanged={vi.fn()}
      />
    )
    // body visible: one assign control per label, plus the voice-memory notice
    expect(await screen.findByRole('button', { name: /assign contact to a/i })).toBeInTheDocument()
    expect(screen.getByText(/voice memory is off/i)).toBeInTheDocument()

    // toggle the panel collapsed
    fireEvent.click(screen.getByRole('button', { name: /collapse speakers panel/i }))

    // body hidden — assert TWO structurally distinct body elements are gone (the per-label
    // assign button AND the voice-memory notice) so a partial-collapse bug is caught.
    expect(screen.queryByRole('button', { name: /assign contact to a/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/voice memory is off/i)).not.toBeInTheDocument()
    // header remains (now an "expand" toggle)
    expect(screen.getByRole('button', { name: /expand speakers panel/i })).toBeInTheDocument()
    expect(screen.getByText('Speakers')).toBeInTheDocument()
  })
})
