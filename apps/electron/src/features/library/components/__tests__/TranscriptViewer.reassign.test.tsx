import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TranscriptViewer } from '../TranscriptViewer'
import { makeTwoSpeakerTurns, switchToBySpeaker } from './transcriptViewerTestUtils'

vi.mock('@/components/ui/toaster', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'electronAPI', {
    value: {
      contacts: {
        getForMeeting: vi.fn().mockResolvedValue({ success: true, data: [] }),
        getAll: vi.fn().mockResolvedValue({ success: true, data: { contacts: [], total: 0 } }),
        create: vi.fn(),
      },
    },
    writable: true,
    configurable: true,
  })
})

describe('TranscriptViewer — by-speaker reassign control', () => {
  it('does NOT render a reassign control when no onReassign handler is provided', () => {
    render(<TranscriptViewer transcript="" turns={makeTwoSpeakerTurns()} onSeek={vi.fn()} />)
    switchToBySpeaker()
    expect(screen.queryByRole('button', { name: /^reassign turn/i })).not.toBeInTheDocument()
  })

  it('renders the three scope options on a turn row when onReassign is provided', async () => {
    render(
      <TranscriptViewer
        transcript=""
        turns={makeTwoSpeakerTurns()}
        onSeek={vi.fn()}
        onReassign={vi.fn()}
        canMintNewSpeaker
      />
    )
    switchToBySpeaker()
    // Open the menu on the FIRST Alpha turn (global index 0).
    fireEvent.click(screen.getAllByRole('button', { name: /^reassign turn/i })[0])
    expect(await screen.findByRole('button', { name: /^reassign$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /reassign all before/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /reassign all after/i })).toBeInTheDocument()
  })

  it('picking a scope then a target calls onReassign with the correct global anchorIndex, scope, and target', async () => {
    const onReassign = vi.fn()
    render(
      <TranscriptViewer
        transcript=""
        turns={makeTwoSpeakerTurns()}
        speakerNames={{ A: 'Alice' }}
        onSeek={vi.fn()}
        onReassign={onReassign}
        canMintNewSpeaker
      />
    )
    switchToBySpeaker()
    // makeTwoSpeakerTurns(): [A@0, B@4000, A@9000]. The SECOND Alpha turn is global index 2.
    // It is the 2nd reassign control inside speaker A's card.
    fireEvent.click(screen.getByText('Alpha second line.').closest('[data-testid="by-speaker-turn"]')!
      .querySelector('button[aria-label^="Reassign turn"]')! as HTMLElement)
    fireEvent.click(await screen.findByRole('button', { name: /reassign all after/i }))
    // Target picker opens: pick existing speaker B ("Speaker B" since B is unnamed).
    fireEvent.click(await screen.findByRole('button', { name: /reassign to speaker b/i }))
    expect(onReassign).toHaveBeenCalledWith({
      sourceLabel: 'A',
      anchorIndex: 2,
      anchorStartMs: 9000,
      scope: 'after',
      target: { kind: 'existingLabel', label: 'B' },
    })
  })
})
