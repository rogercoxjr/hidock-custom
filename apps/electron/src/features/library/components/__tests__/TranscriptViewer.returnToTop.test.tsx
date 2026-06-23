import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TranscriptViewer } from '../TranscriptViewer'
import { makeTwoSpeakerTurns } from './transcriptViewerTestUtils'

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

describe('TranscriptViewer — return-to-top (QOL #1)', () => {
  it('hides the button at the top, shows it past the threshold, and scrolls to top on click', () => {
    render(<TranscriptViewer transcript="" turns={makeTwoSpeakerTurns()} onSeek={vi.fn()} />)
    // hidden at scrollTop 0 — conditional render: must be absent from DOM, not just invisible
    expect(screen.queryByRole('button', { name: /back to top/i })).not.toBeInTheDocument()

    // the scroll container is the element with overflow-y-auto + max-h-[60vh]
    const container = screen.getByTestId('transcript-scroll-container') as HTMLDivElement
    expect(container).toBeTruthy()
    const scrollTo = vi.fn()
    container.scrollTo = scrollTo as unknown as typeof container.scrollTo

    // simulate scrolling past the 300px threshold
    Object.defineProperty(container, 'scrollTop', { value: 500, configurable: true })
    fireEvent.scroll(container)

    const btn = screen.getByRole('button', { name: /back to top/i })
    expect(btn).toBeInTheDocument()
    // structural guard: the button must live on the relative parent, NOT inside the
    // scrolling child (jsdom has no layout engine, so a role/name query alone would
    // still pass if a future change re-nested the button where it would scroll away).
    expect(container.contains(btn)).toBe(false)

    fireEvent.click(btn)
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' })
    // exactly once — a double-fire (two listeners attached via a wrong deps array)
    // would make this fail and surface the bug.
    expect(scrollTo).toHaveBeenCalledTimes(1)
  })

  it('hides the button again when scrolled back under the threshold', () => {
    render(<TranscriptViewer transcript="" turns={makeTwoSpeakerTurns()} onSeek={vi.fn()} />)
    const container = screen.getByTestId('transcript-scroll-container') as HTMLDivElement
    Object.defineProperty(container, 'scrollTop', { value: 500, configurable: true })
    fireEvent.scroll(container)
    expect(screen.getByRole('button', { name: /back to top/i })).toBeInTheDocument()
    Object.defineProperty(container, 'scrollTop', { value: 100, configurable: true })
    fireEvent.scroll(container)
    // conditional render: must be absent from DOM, not just invisible (do NOT switch
    // the implementation to opacity-0/hidden — the spec uses conditional rendering).
    expect(screen.queryByRole('button', { name: /back to top/i })).not.toBeInTheDocument()
  })
})
