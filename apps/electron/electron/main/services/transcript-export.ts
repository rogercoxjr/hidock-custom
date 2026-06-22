/**
 * Transcript export — pure formatters and helpers (no Electron / DB imports).
 *
 * The IPC handler (transcripts:export) assembles ExportData from the DB and calls
 * one of toCsv / toSrt / toJson. These functions are pure so they unit-test without
 * Electron, React, or sql.js, and a future bulk-export reuses them unchanged.
 */

import type { Turn } from './asr/asr-provider'

export interface ExportData {
  recording: {
    id: string
    title: string
    dateRecorded: string
    durationMs: number | null
    language: string
    transcriptionProvider: string | null
    transcriptionModel: string | null
  }
  fullText: string
  turns: Turn[] | null
  analysis: {
    summary: string | null
    actionItems: string[]
    topics: string[]
    keyPoints: string[]
    titleSuggestion: string | null
    sentiment: string | null
  }
  speakers: Record<string, string>
}

/** Format milliseconds as HH:MM:SS<sep>mmm. `sep` is ',' for SRT, '.' for CSV. */
export function msToClock(ms: number, sep: ',' | '.'): string {
  const total = Math.max(0, Math.round(ms))
  const millis = total % 1000
  const totalSeconds = Math.floor(total / 1000)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  const pad2 = (n: number): string => String(n).padStart(2, '0')
  const pad3 = (n: number): string => String(n).padStart(3, '0')
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}${sep}${pad3(millis)}`
}

/** RFC-4180 quoting: quote iff the field contains ", , CR or LF; double embedded quotes. */
export function csvEscape(field: string): string {
  if (/[",\r\n]/.test(field)) {
    return `"${field.replace(/"/g, '""')}"`
  }
  return field
}

/** Mapped display name when present and non-empty, else the raw label. */
export function resolveSpeaker(label: string, speakers: Record<string, string>): string {
  const name = speakers[label]
  return name && name.trim().length > 0 ? name : label
}

/** Windows-safe base filename derived from a recording title; "transcript" when empty. */
export function sanitizeBasename(title: string): string {
  const cleaned = (title || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > 0 ? cleaned : 'transcript'
}

/** Complete-record JSON (spec §6.3). Always available; turns is null when not diarized. */
export function toJson(data: ExportData): string {
  const record = {
    version: 1,
    recording: {
      id: data.recording.id,
      title: data.recording.title,
      dateRecorded: data.recording.dateRecorded,
      durationMs: data.recording.durationMs,
      language: data.recording.language,
      transcriptionProvider: data.recording.transcriptionProvider,
      transcriptionModel: data.recording.transcriptionModel
    },
    transcript: {
      language: data.recording.language,
      fullText: data.fullText,
      turns: data.turns
    },
    analysis: {
      summary: data.analysis.summary,
      actionItems: data.analysis.actionItems,
      topics: data.analysis.topics,
      keyPoints: data.analysis.keyPoints,
      titleSuggestion: data.analysis.titleSuggestion,
      sentiment: data.analysis.sentiment
    },
    speakers: data.speakers
  }
  return JSON.stringify(record, null, 2)
}
