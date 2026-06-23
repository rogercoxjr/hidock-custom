import { fireEvent, screen } from '@testing-library/react'
import type { Turn } from '../../types/turns'

// Canonical two-speaker fixture: distinct text per turn so per-group visibility
// can be asserted; A appears twice so per-speaker collapse can hide both A lines.
export function makeTwoSpeakerTurns(): Turn[] {
  return [
    { speaker: 'A', startMs: 0, endMs: 4000, text: 'Alpha first line.' },
    { speaker: 'B', startMs: 4000, endMs: 9000, text: 'Bravo first line.' },
    { speaker: 'A', startMs: 9000, endMs: 12000, text: 'Alpha second line.' },
  ]
}

// SegmentedToggle renders each option as <button role="tab">; the explicit
// role="tab" overrides the implicit button role, so query by tab, not button.
export function switchToBySpeaker(): void {
  fireEvent.click(screen.getByRole('tab', { name: /by speaker/i }))
}
