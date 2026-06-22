import { describe, it, expect } from 'vitest'
import {
  msToClock,
  csvEscape,
  resolveSpeaker,
  sanitizeBasename
} from '../transcript-export'
import type { ExportData } from '../transcript-export'

// ---------------------------------------------------------------------------
// Shared fixture helpers — used by the toJson, toCsv, and toSrt tests added in
// Tasks 2–4 below. Defined once here so those append-only test blocks do NOT
// redefine them. `baseData()` is a fully-populated non-diarized ExportData;
// `diarized(turns)` is the same record with a turns array spliced in.
// ---------------------------------------------------------------------------
function baseData(): ExportData {
  return {
    recording: {
      id: 'rec1',
      title: 'Weekly Sync',
      dateRecorded: '2026-06-22T10:00:00.000Z',
      durationMs: 123000,
      language: 'en',
      transcriptionProvider: 'assemblyai',
      transcriptionModel: 'best'
    },
    fullText: 'Hello world',
    turns: null,
    analysis: {
      summary: 'A short meeting.',
      actionItems: ['Ship it'],
      topics: ['release'],
      keyPoints: ['went well'],
      titleSuggestion: 'Weekly Sync',
      sentiment: 'POSITIVE'
    },
    speakers: { Speaker_0: 'Alice Johnson', Speaker_1: 'Speaker_1' }
  }
}

function diarized(turns: ExportData['turns']): ExportData {
  return { ...baseData(), turns }
}

describe('msToClock', () => {
  it('formats 0 ms', () => {
    expect(msToClock(0, ',')).toBe('00:00:00,000')
    expect(msToClock(0, '.')).toBe('00:00:00.000')
  })
  it('formats sub-second boundaries', () => {
    expect(msToClock(999, ',')).toBe('00:00:00,999')
    expect(msToClock(1000, ',')).toBe('00:00:01,000')
    expect(msToClock(59_999, ',')).toBe('00:00:59,999')
  })
  it('formats one hour exactly', () => {
    expect(msToClock(3_600_000, ',')).toBe('01:00:00,000')
  })
  it('formats a duration just over one hour', () => {
    expect(msToClock(3_661_001, ',')).toBe('01:01:01,001')
  })
  it('does not truncate hours beyond two digits', () => {
    expect(msToClock(36_000_000, ',')).toBe('10:00:00,000')
  })
  it('rounds fractional milliseconds to the nearest ms', () => {
    expect(msToClock(1500.6, ',')).toBe('00:00:01,501')
    expect(msToClock(1500.4, ',')).toBe('00:00:01,500')
  })
  it('clamps negatives to zero', () => {
    expect(msToClock(-5, ',')).toBe('00:00:00,000')
  })
})

describe('csvEscape', () => {
  it('leaves plain text unquoted', () => {
    expect(csvEscape('hello')).toBe('hello')
  })
  it('quotes fields containing a comma', () => {
    expect(csvEscape('a,b')).toBe('"a,b"')
  })
  it('quotes and doubles embedded double-quotes', () => {
    expect(csvEscape('she said "hi"')).toBe('"she said ""hi"""')
  })
  it('quotes fields containing newlines or carriage returns', () => {
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"')
    expect(csvEscape('a\rb')).toBe('"a\rb"')
  })
})

describe('resolveSpeaker', () => {
  it('returns the mapped display name when present', () => {
    expect(resolveSpeaker('Speaker_0', { Speaker_0: 'Alice Johnson' })).toBe('Alice Johnson')
  })
  it('falls back to the raw label when unmapped', () => {
    expect(resolveSpeaker('Speaker_1', { Speaker_0: 'Alice Johnson' })).toBe('Speaker_1')
  })
  it('falls back to the label when the mapped value is empty', () => {
    expect(resolveSpeaker('Speaker_0', { Speaker_0: '' })).toBe('Speaker_0')
  })
  it('preserves a Unicode display name', () => {
    expect(resolveSpeaker('Speaker_0', { Speaker_0: '田中 花子' })).toBe('田中 花子')
  })
})

describe('sanitizeBasename', () => {
  it('strips Windows-illegal characters', () => {
    expect(sanitizeBasename('a<b>c:d"e/f\\g|h?i*j')).toBe('abcdefghij')
  })
  it('collapses whitespace and trims', () => {
    expect(sanitizeBasename('  My   Meeting  ')).toBe('My Meeting')
  })
  it('preserves non-ASCII (CJK) characters', () => {
    expect(sanitizeBasename('会議レポート 2026')).toBe('会議レポート 2026')
  })
  it('falls back to "transcript" when empty after sanitizing', () => {
    expect(sanitizeBasename('   ')).toBe('transcript')
    expect(sanitizeBasename('/\\:*?')).toBe('transcript')
  })
})

// Suppress unused-variable warnings for shared fixtures referenced by Tasks 2–4
export { baseData, diarized }
