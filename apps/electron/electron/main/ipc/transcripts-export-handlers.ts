/**
 * Transcript Export IPC Handler (transcripts:export)
 *
 * Loads a recording's transcript + metadata + speaker roster, builds a normalized
 * ExportData, gates CSV/SRT on diarization (server-side backstop — the UI also
 * disables them), runs the matching pure formatter, and saves via the native dialog.
 * Mirrors the file-save pattern in outputs-handlers.ts.
 */

import { ipcMain, dialog, BrowserWindow } from 'electron'
import { writeFileSync } from 'fs'
import { success, error, Result } from '../types/api'
import {
  getTranscriptByRecordingId,
  getRecordingById,
  getRecordingSpeakers,
  getContactById
} from '../services/database'
import {
  toCsv,
  toSrt,
  toJson,
  sanitizeBasename,
  type ExportData
} from '../services/transcript-export'
import type { Turn } from '../services/asr/asr-provider'

type ExportFormat = 'csv' | 'srt' | 'json'

/** Parse a JSON string into a string[]; any failure or non-array yields []. */
function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : []
  } catch {
    return []
  }
}

/** Parse the turns JSON string into Turn[]; any failure or non-array yields null (non-diarized). */
function parseTurns(raw: string | null | undefined): Turn[] | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) && parsed.length > 0 ? (parsed as Turn[]) : null
  } catch {
    return null
  }
}

const DIALOG_FILTERS: Record<ExportFormat, { name: string; extensions: string[] }> = {
  csv: { name: 'CSV', extensions: ['csv'] },
  srt: { name: 'SubRip Subtitle', extensions: ['srt'] },
  json: { name: 'JSON', extensions: ['json'] }
}

export function registerTranscriptsExportHandlers(): void {
  ipcMain.handle(
    'transcripts:export',
    async (event, request: unknown): Promise<Result<string | null>> => {
      try {
        // Validate input
        const req = request as { recordingId?: unknown; format?: unknown } | null
        const recordingId = req && typeof req.recordingId === 'string' ? req.recordingId : ''
        const format = req && (req.format === 'csv' || req.format === 'srt' || req.format === 'json')
          ? (req.format as ExportFormat)
          : null
        if (!recordingId || !format) {
          return error('VALIDATION_ERROR', 'Invalid export request: need a recordingId and a csv|srt|json format')
        }

        // Load transcript
        const transcript = getTranscriptByRecordingId(recordingId)
        if (!transcript) {
          return error('NOT_FOUND', 'No transcript to export')
        }

        // Parse turns defensively → diarization gate
        const turns = parseTurns(transcript.turns)
        const isDiarized = Array.isArray(turns) && turns.length > 0
        if ((format === 'csv' || format === 'srt') && !isDiarized) {
          return error(
            'NOT_DIARIZED',
            'CSV and SRT export require diarization. Re-transcribe with diarization to enable.'
          )
        }

        // Recording metadata. Title prefers the AI title; the filename fallbacks have their
        // file extension stripped so the default save name is not e.g. "My Recording.wav.json".
        const recording = getRecordingById(recordingId)
        const stripExt = (name: string): string => name.replace(/\.[^./\\]+$/, '')
        const fileFallback = recording?.original_filename || recording?.filename
        // Trim the AI title first: a whitespace-only suggestion (e.g. '   ') is otherwise
        // truthy and wins the chain, serializing junk into recording.title while
        // sanitizeBasename collapses it to 'transcript' for the filename — content/name diverge.
        const aiTitle = transcript.title_suggestion?.trim()
        const title =
          aiTitle ||
          (fileFallback ? stripExt(fileFallback) : '') ||
          'transcript'
        const durationMs =
          recording && typeof recording.duration_seconds === 'number'
            ? Math.round(recording.duration_seconds * 1000)
            : null

        // Speaker roster: file_label -> contact name (fallback handled by resolveSpeaker)
        const speakers: Record<string, string> = {}
        for (const row of getRecordingSpeakers(recordingId)) {
          if (!row.contact_id) continue
          const contact = getContactById(row.contact_id)
          if (contact) speakers[row.file_label] = contact.name
        }

        const data: ExportData = {
          recording: {
            id: recordingId,
            title,
            dateRecorded: recording?.date_recorded ?? '',
            durationMs,
            language: transcript.language ?? '',
            transcriptionProvider: transcript.transcription_provider ?? null,
            transcriptionModel: transcript.transcription_model ?? null
          },
          fullText: transcript.full_text ?? '',
          turns,
          analysis: {
            summary: transcript.summary ?? null,
            actionItems: parseStringArray(transcript.action_items),
            topics: parseStringArray(transcript.topics),
            keyPoints: parseStringArray(transcript.key_points),
            titleSuggestion: transcript.title_suggestion ?? null,
            sentiment: transcript.sentiment ?? null
          },
          speakers
        }

        const content =
          format === 'csv' ? toCsv(data) : format === 'srt' ? toSrt(data) : toJson(data)

        const win = BrowserWindow.fromWebContents(event.sender)
        if (!win) {
          return error('INTERNAL_ERROR', 'No window found')
        }

        const defaultPath = `${sanitizeBasename(title)}.${format}`
        const result = await dialog.showSaveDialog(win, {
          defaultPath,
          filters: [DIALOG_FILTERS[format], { name: 'All Files', extensions: ['*'] }]
        })

        if (result.canceled || !result.filePath) {
          return success(null)
        }

        writeFileSync(result.filePath, content, 'utf-8')
        return success(result.filePath)
      } catch (err) {
        console.error('transcripts:export error:', err)
        return error('INTERNAL_ERROR', 'Failed to export transcript', err)
      }
    }
  )

  console.log('Transcript export IPC handler registered')
}
