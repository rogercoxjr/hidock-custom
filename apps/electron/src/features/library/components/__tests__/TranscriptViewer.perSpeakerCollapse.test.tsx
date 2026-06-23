import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TranscriptViewer } from '../TranscriptViewer'
import { makeTwoSpeakerTurns, switchToBySpeaker } from './transcriptViewerTestUtils'

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

describe('TranscriptViewer — per-speaker collapse (QOL #2)', () => {
  it('shows each speaker turn list by default, hides only the toggled speaker, keeps the header', () => {
    render(<TranscriptViewer transcript="" turns={makeTwoSpeakerTurns()} onSeek={vi.fn()} />)
    // switchToBySpeaker() queries getByRole('tab', …): SegmentedToggle options are
    // role="tab", NOT button, so a getByRole('button', …) query would throw here.
    switchToBySpeaker()

    // both speakers' turns visible by default
    expect(screen.getByText('Alpha first line.')).toBeInTheDocument()
    expect(screen.getByText('Alpha second line.')).toBeInTheDocument()
    expect(screen.getByText('Bravo first line.')).toBeInTheDocument()

    // collapse speaker A (the per-card chevron IS a real <button>, so getByRole button is correct here)
    fireEvent.click(screen.getByRole('button', { name: /collapse speaker a/i }))

    // Assertions ordered content-gone → UI-state-updated so a failure pinpoints the cause:
    // both A turns must be ABSENT from the DOM (conditional render, not hidden) ...
    expect(screen.queryByText('Alpha first line.')).not.toBeInTheDocument()
    expect(screen.queryByText('Alpha second line.')).not.toBeInTheDocument()
    // B is unaffected ...
    expect(screen.getByText('Bravo first line.')).toBeInTheDocument()
    // ... and finally the header chevron re-labels to "expand" (a failure here is a labeling bug,
    // not a render bug).
    expect(screen.getByRole('button', { name: /expand speaker a/i })).toBeInTheDocument()
  })
})
