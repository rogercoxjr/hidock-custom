import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SpeakersPanel } from '../SpeakersPanel'
import { setupSpeakersPanelMocks, makeTurns } from './speakersPanelTestUtils'

vi.mock('@/components/ui/toaster', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  setupSpeakersPanelMocks()
})

describe('SpeakersPanel — assigned names at label sites (QOL #4)', () => {
  it('shows the assigned name leading a muted letter tag for an assigned speaker, letter for unassigned', async () => {
    render(
      <SpeakersPanel
        recordingId="rec-1"
        meetingId="meet-1"
        turns={makeTurns()}
        assignedSpeakers={{ A: { contactId: 'c-1', contactName: 'Alice' } }}
        assignedNames={{ A: 'Alice' }}
        onChanged={vi.fn()}
      />
    )
    // A is assigned -> the name leads in the chip (exactly once now that the
    // redundant stat-line badge is removed).
    const alice = await screen.findByText('Alice')
    expect(alice).toBeInTheDocument()

    // The raw letter is rendered as a dedicated muted tag (stable testid, not a
    // className sniff). There may be more than one such tag across the panel;
    // assert at least one exists and carries the letter 'A'.
    const letterTags = screen.getAllByTestId('speaker-letter-tag')
    expect(letterTags.length).toBeGreaterThan(0)
    const aTag = letterTags.find((n) => n.textContent === 'A')
    expect(aTag).toBeTruthy()

    // Ordering: within the chip, the name precedes the muted letter tag.
    // (name node comes BEFORE the letter tag in document order)
    expect(alice.compareDocumentPosition(aTag!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // B is unassigned -> shows the bare letter and the assign control keyed on the letter.
    expect(screen.getByRole('button', { name: /assign contact to b/i })).toBeInTheDocument()
    // 'Alice' must NOT appear as a standalone second node (no duplicate badge).
    expect(screen.getAllByText('Alice')).toHaveLength(1)
  })
})
