import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TranscriptViewer } from '../TranscriptViewer'
import type { Turn } from '../../types/turns'

// scrollIntoView is not implemented in jsdom
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

function makeTurns(): Turn[] {
  return [
    { speaker: 'A', startMs: 0, endMs: 4000, text: 'Opening remarks.' },
    { speaker: 'B', startMs: 4000, endMs: 9000, text: 'A reply.' },
  ]
}

describe('TranscriptViewer — structured turns (AC3/AC8)', () => {
  it('renders structured turns with speaker badges when turns present', () => {
    render(
      <TranscriptViewer transcript="ignored flat text" turns={makeTurns()} onSeek={vi.fn()} />
    )
    expect(screen.getByText('Opening remarks.')).toBeInTheDocument()
    expect(screen.getByText('A reply.')).toBeInTheDocument()
    // Speaker labels render as badges
    expect(screen.getByText('A')).toBeInTheDocument()
    expect(screen.getByText('B')).toBeInTheDocument()
    // Structured mode renders dedicated speaker-badge elements (one per turn)
    expect(screen.getAllByTestId('speaker-badge')).toHaveLength(2)
  })

  it('maps file_label to a contact name via speakerNames', () => {
    render(
      <TranscriptViewer
        transcript=""
        turns={makeTurns()}
        speakerNames={{ A: 'Alice', B: 'Bob' }}
        onSeek={vi.fn()}
      />
    )
    expect(screen.getByText('Alice')).toBeInTheDocument()
    expect(screen.getByText('Bob')).toBeInTheDocument()
    // raw labels no longer shown as the badge
    expect(screen.queryByText('A')).not.toBeInTheDocument()
  })

  it('REGRESSION: falls back to legacy text-prefix parser when turns absent (AC8)', () => {
    render(
      <TranscriptViewer
        transcript={'[00:00] Alice: Hello\n[00:05] Bob: Hi'}
        onSeek={vi.fn()}
      />
    )
    // legacy parser extracts "Alice"/"Bob" as text-prefix speakers
    expect(screen.getByText('Hello')).toBeInTheDocument()
    expect(screen.getByText('Hi')).toBeInTheDocument()
    // NEGATIVE: no structured color-coded speaker-badge element renders without turns
    expect(screen.queryAllByTestId('speaker-badge')).toHaveLength(0)
  })

  it('REGRESSION: plain text (no timestamps, no turns) renders as a single block (AC8)', () => {
    render(<TranscriptViewer transcript="Just some plain text." onSeek={vi.fn()} />)
    expect(screen.getByText('Just some plain text.')).toBeInTheDocument()
  })
})

describe('TranscriptViewer — no summary section (QOL #5)', () => {
  it('does not render a Summary section even when a summary string would have been passed', () => {
    render(
      <TranscriptViewer
        transcript="Plain transcript body."
        actionItems={['Do the thing']}
        showActionItems
        onSeek={vi.fn()}
      />
    )
    expect(screen.queryByText('Summary')).not.toBeInTheDocument()
    // Action items remain owned by TranscriptViewer
    expect(screen.getByText('Action Items')).toBeInTheDocument()
    expect(screen.getByText('Do the thing')).toBeInTheDocument()
  })
})
