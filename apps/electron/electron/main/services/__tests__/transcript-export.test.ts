import { describe, it, expect } from 'vitest'
import {
  msToClock,
  csvEscape,
  resolveSpeaker,
  sanitizeBasename,
  toJson
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

describe('toJson', () => {
  it('emits version 1 and the full record for a non-diarized recording (turns null)', () => {
    const out = JSON.parse(toJson(baseData()))
    expect(out.version).toBe(1)
    expect(out.recording).toEqual({
      id: 'rec1',
      title: 'Weekly Sync',
      dateRecorded: '2026-06-22T10:00:00.000Z',
      durationMs: 123000,
      language: 'en',
      transcriptionProvider: 'assemblyai',
      transcriptionModel: 'best'
    })
    expect(out.transcript).toEqual({ language: 'en', fullText: 'Hello world', turns: null })
    expect(out.analysis).toEqual({
      summary: 'A short meeting.',
      actionItems: ['Ship it'],
      topics: ['release'],
      keyPoints: ['went well'],
      titleSuggestion: 'Weekly Sync',
      sentiment: 'POSITIVE'
    })
    expect(out.speakers).toEqual({ Speaker_0: 'Alice Johnson', Speaker_1: 'Speaker_1' })
  })

  it('includes the turns array verbatim for a diarized recording', () => {
    const data = baseData()
    data.turns = [
      { speaker: 'Speaker_0', startMs: 0, endMs: 1000, text: 'Hi' },
      { speaker: 'Speaker_1', startMs: 1000, endMs: 2000, text: 'Hello', sentiment: 'NEUTRAL' }
    ]
    const out = JSON.parse(toJson(data))
    expect(out.transcript.turns).toEqual(data.turns)
  })

  it('pretty-prints with two-space indentation', () => {
    expect(toJson(baseData())).toContain('\n  "version": 1')
  })

  it('serializes a zero-analysis recording with empty arrays and null scalars (no undefined)', () => {
    const data = baseData()
    data.analysis = {
      summary: null,
      actionItems: [],
      topics: [],
      keyPoints: [],
      titleSuggestion: null,
      sentiment: null
    }
    const text = toJson(data)
    const out = JSON.parse(text)
    expect(out.analysis.actionItems).toEqual([]) // not null
    expect(out.analysis.topics).toEqual([])
    expect(out.analysis.keyPoints).toEqual([])
    expect(out.analysis.summary).toBeNull() // present-and-null, not omitted
    expect(out.analysis.titleSuggestion).toBeNull()
    expect(out.analysis.sentiment).toBeNull()
    // JSON.stringify drops undefined keys; assert none were dropped.
    expect(Object.keys(out.analysis).sort()).toEqual(
      ['actionItems', 'keyPoints', 'sentiment', 'summary', 'titleSuggestion', 'topics'].sort()
    )
  })
})

// Suppress unused-variable warnings for shared fixtures referenced by Tasks 2–4
export { baseData, diarized }
