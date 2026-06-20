import { describe, it, expect } from 'vitest'
import {
  computeSpeakerOptions,
  DEFAULT_SPEAKER_OPTIONS_POLICY
} from '../speaker-options-policy'

const DEFAULT = DEFAULT_SPEAKER_OPTIONS_POLICY

describe('speaker-options-policy', () => {
  it('returns null for unknown or short durations', () => {
    expect(computeSpeakerOptions(null)).toBeNull()
    expect(computeSpeakerOptions(undefined)).toBeNull()
    expect(computeSpeakerOptions(60000)).toBeNull()
  })

  it('returns the policy min/max for long enough recordings', () => {
    expect(computeSpeakerOptions(120000)).toEqual({
      min_speakers_expected: DEFAULT.minSpeakers,
      max_speakers_expected: DEFAULT.maxSpeakers
    })
    expect(computeSpeakerOptions(600000)).toEqual({
      min_speakers_expected: DEFAULT.minSpeakers,
      max_speakers_expected: DEFAULT.maxSpeakers
    })
  })

  it('respects overrides', () => {
    expect(computeSpeakerOptions(600000, { minSpeakers: 1, maxSpeakers: 6 })).toEqual({
      min_speakers_expected: 1,
      max_speakers_expected: 6
    })
    expect(computeSpeakerOptions(600000, { minSpeakers: 2 })).toEqual({
      min_speakers_expected: 2,
      max_speakers_expected: DEFAULT.maxSpeakers
    })
    expect(computeSpeakerOptions(600000, { minDurationMsForHint: 700000 })).toBeNull()
  })

  it('returns null when the feature is disabled', () => {
    expect(computeSpeakerOptions(600000, { speakerOptionsEnabled: false })).toBeNull()
  })
})
