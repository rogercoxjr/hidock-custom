import { describe, it, expect } from 'vitest'
import {
  msToClock,
  csvEscape,
  resolveSpeaker,
  sanitizeBasename,
  toJson,
  toCsv
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

describe('toCsv', () => {
  it('begins with a UTF-8 BOM and a header row, and uses CRLF terminators', () => {
    const out = toCsv(diarized([{ speaker: 'Speaker_0', startMs: 0, endMs: 1000, text: 'Hi' }]))
    expect(out.charCodeAt(0)).toBe(0xfeff)
    expect(out.slice(1).startsWith('speaker,start,end,text\r\n')).toBe(true)
  })

  it('emits one row per turn with HH:MM:SS.mmm timestamps and resolved speaker names', () => {
    const out = toCsv(diarized([
      { speaker: 'Speaker_0', startMs: 0, endMs: 1500, text: 'Hello' },
      { speaker: 'Speaker_9', startMs: 1500, endMs: 3000, text: 'World' }
    ]))
    const rows = out.slice(1).split('\r\n')
    expect(rows[0]).toBe('speaker,start,end,text')
    expect(rows[1]).toBe('Alice Johnson,00:00:00.000,00:00:01.500,Hello')
    expect(rows[2]).toBe('Speaker_9,00:00:01.500,00:00:03.000,World')
  })

  it('quotes text containing a comma (RFC-4180 trigger)', () => {
    const out = toCsv(diarized([{ speaker: 'Speaker_0', startMs: 0, endMs: 1000, text: 'a,b' }]))
    expect(out.slice(1).split('\r\n')[1]).toBe('Alice Johnson,00:00:00.000,00:00:01.000,"a,b"')
  })

  it('quotes and doubles an embedded double-quote (RFC-4180 trigger)', () => {
    const out = toCsv(diarized([{ speaker: 'Speaker_0', startMs: 0, endMs: 1000, text: 'say "hi"' }]))
    expect(out.slice(1).split('\r\n')[1]).toBe('Alice Johnson,00:00:00.000,00:00:01.000,"say ""hi"""')
  })

  it('quotes text containing an embedded newline (RFC-4180 trigger)', () => {
    const out = toCsv(diarized([{ speaker: 'Speaker_0', startMs: 0, endMs: 1000, text: 'a\nb' }]))
    expect(out.slice(1)).toBe('speaker,start,end,text\r\nAlice Johnson,00:00:00.000,00:00:01.000,"a\nb"')
  })

  it('quotes text containing a bare carriage return (RFC-4180 trigger)', () => {
    const out = toCsv(diarized([{ speaker: 'Speaker_0', startMs: 0, endMs: 1000, text: 'a\rb' }]))
    expect(out.slice(1)).toBe('speaker,start,end,text\r\nAlice Johnson,00:00:00.000,00:00:01.000,"a\rb"')
  })

  it('throws when given an empty turns array (formatter contract guard)', () => {
    expect(() => toCsv({ ...baseData(), turns: [] })).toThrow()
  })

  it('omits the sentiment column when no turn has a sentiment', () => {
    const out = toCsv(diarized([{ speaker: 'Speaker_0', startMs: 0, endMs: 1000, text: 'Hi' }]))
    expect(out.slice(1).split('\r\n')[0]).toBe('speaker,start,end,text')
  })

  it('adds a trailing sentiment column when any turn has a sentiment', () => {
    const out = toCsv(diarized([
      { speaker: 'Speaker_0', startMs: 0, endMs: 1000, text: 'Hi', sentiment: 'POSITIVE' },
      { speaker: 'Speaker_1', startMs: 1000, endMs: 2000, text: 'Bye' }
    ]))
    const rows = out.slice(1).split('\r\n')
    expect(rows[0]).toBe('speaker,start,end,text,sentiment')
    expect(rows[1]).toBe('Alice Johnson,00:00:00.000,00:00:01.000,Hi,POSITIVE')
    expect(rows[2]).toBe('Speaker_1,00:00:01.000,00:00:02.000,Bye,')
    // The sentiment-less row keeps the sentinel cell (5 fields), not 4 — fixed column count.
    expect(rows[2].split(',').length).toBe(5)
  })
})

// Suppress unused-variable warnings for shared fixtures referenced by Tasks 2–4
export { baseData, diarized }
