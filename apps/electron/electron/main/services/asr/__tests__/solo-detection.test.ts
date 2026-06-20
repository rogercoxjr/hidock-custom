import { describe, it, expect } from 'vitest'
import { classifyRunOutcome, SOLO_MINOR_MAX_MS } from '../solo-detection'
import type { Turn, SpeakerOptions } from '../asr-provider'

const OPTIONS: SpeakerOptions = { min_speakers_expected: 1, max_speakers_expected: 8 }

function turn(speaker: string, startMs: number, endMs: number, text = 'x'): Turn {
  return { speaker, startMs, endMs, text }
}

describe('solo-detection / run outcome', () => {
  it('single label is solo', () => {
    const outcome = classifyRunOutcome([turn('A', 0, 5000)], OPTIONS, 5000)
    expect(outcome.labelCount).toBe(1)
    expect(outcome.isSolo).toBe(true)
    expect(outcome.soloReason).toBe('single_label')
    expect(outcome.failure).toBeNull()
  })

  it('no turns on a non-empty recording is a no_turns failure and solo', () => {
    const outcome = classifyRunOutcome([], OPTIONS, 5000)
    expect(outcome.labelCount).toBe(0)
    expect(outcome.isSolo).toBe(true)
    expect(outcome.soloReason).toBe('single_label')
    expect(outcome.failure).toBe('no_turns')
  })

  it('dominant speaker over 97% with minor under 3s is solo over-split', () => {
    const turns: Turn[] = [
      turn('A', 0, 600000),
      turn('B', 600000, 600000 + SOLO_MINOR_MAX_MS - 1)
    ]
    const outcome = classifyRunOutcome(turns, OPTIONS, 600000 + SOLO_MINOR_MAX_MS)
    expect(outcome.labelCount).toBe(2)
    expect(outcome.isSolo).toBe(true)
    expect(outcome.soloReason).toBe('dominant_single_speaker')
    expect(outcome.failure).toBeNull()
  })

  it('real two-person conversation is not solo', () => {
    const turns: Turn[] = [
      turn('A', 0, 300000),
      turn('B', 300000, 420000)
    ]
    const outcome = classifyRunOutcome(turns, OPTIONS, 420000)
    expect(outcome.labelCount).toBe(2)
    expect(outcome.isSolo).toBe(false)
    expect(outcome.soloReason).toBeNull()
    expect(outcome.failure).toBeNull()
  })

  it('label count pinned to max is hit_ceiling', () => {
    const turns: Turn[] = Array.from({ length: 8 }, (_, i) =>
      turn(String.fromCharCode(65 + i), i * 1000, i * 1000 + 500)
    )
    const outcome = classifyRunOutcome(turns, OPTIONS, 10000)
    expect(outcome.labelCount).toBe(8)
    expect(outcome.failure).toBe('hit_ceiling')
    expect(outcome.isSolo).toBe(false)
  })

  it('label count exceeding max is over_floor', () => {
    const turns: Turn[] = Array.from({ length: 9 }, (_, i) =>
      turn(String.fromCharCode(65 + i), i * 1000, i * 1000 + 500)
    )
    const outcome = classifyRunOutcome(turns, OPTIONS, 10000)
    expect(outcome.labelCount).toBe(9)
    expect(outcome.failure).toBe('over_floor')
  })

  it('normal multi-speaker run within range has no failure', () => {
    const turns: Turn[] = [
      turn('A', 0, 10000),
      turn('B', 10000, 20000),
      turn('C', 20000, 30000)
    ]
    const outcome = classifyRunOutcome(turns, OPTIONS, 30000)
    expect(outcome.labelCount).toBe(3)
    expect(outcome.isSolo).toBe(false)
    expect(outcome.failure).toBeNull()
  })
})
