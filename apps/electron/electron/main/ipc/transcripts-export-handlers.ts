/**
 * Transcript Export IPC Handler
 *
 * Handles the `transcripts:export` channel: loads a recording's transcript +
 * recording row + speaker roster from the DB, assembles ExportData, gates CSV/SRT
 * on diarization, formats, derives a sanitised default filename, shows the native
 * save dialog, writes the file, and returns Result<string | null>.
 */

import { ipcMain, dialog, BrowserWindow } from 'electron'
import { writeFileSync } from 'fs'
import {
  getRecordingById,
  getTranscriptByRecordingId,
  getRecordingSpeakers,
  getContactById
} from '../services/database'
import {
  toJson,
  toCsv,
  toSrt,
  sanitizeBasename,
  type ExportData
} from '../services/transcript-export'
import { success, error, type Result } from '../types/api'
import type { Turn } from '../services/asr/asr-provider'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Safely parse a JSON string. Returns `null` on any error. */
function tryParseJson<T>(raw: string | undefined | null): T | null {
  if (raw == null || raw.trim() === '') return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/**
 * Strip any file extension from a title used as a filename fallback.
 * "2026-06-22 Weekly Sync.m4a" → "2026-06-22 Weekly Sync"
 * Applied only when the recording row has no explicit title and we fall back to
 * the filename — so the exported file isn't named "meeting.m4a.json".
 */
function stripExtension(name: string): string {
  return name.replace(/\.[^./\\]+$/, '')
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerTranscriptsExportHandlers(): void {
  ipcMain.handle(
    'transcripts:export',
    async (
      event,
      args: unknown
    ): Promise<Result<string | null>> => {
      try {
        if (
          typeof args !== 'object' ||
          args === null ||
          typeof (args as Record<string, unknown>).recordingId !== 'string' ||
          typeof (args as Record<string, unknown>).format !== 'string'
        ) {
          return error('VALIDATION_ERROR', 'recordingId and format are required')
        }

        const { recordingId, format } = args as { recordingId: string; format: string }

        if (format !== 'json' && format !== 'csv' && format !== 'srt') {
          return error('VALIDATION_ERROR', `Unknown format: ${format}. Expected json, csv, or srt.`)
        }

        // ── 1. Load the recording row ──────────────────────────────────────────
        const recording = getRecordingById(recordingId)
        if (!recording) {
          return error('NOT_FOUND', `Recording ${recordingId} not found`)
        }

        // ── 2. Load the transcript row ─────────────────────────────────────────
        const transcript = getTranscriptByRecordingId(recordingId)
        if (!transcript) {
          return error('NOT_FOUND', `No transcript found for recording ${recordingId}`)
        }

        // ── 3. Defensively parse turns ─────────────────────────────────────────
        const turns = tryParseJson<Turn[]>(transcript.turns)

        // ── 4. Diarization gate — must run BEFORE any formatting ───────────────
        if (format === 'csv' || format === 'srt') {
          if (!turns || turns.length === 0) {
            return error(
              'NOT_DIARIZED',
              `Format "${format}" requires diarization. This recording has no speaker turns.`
            )
          }
        }

        // ── 5. Load speaker roster ─────────────────────────────────────────────
        const speakerRows = getRecordingSpeakers(recordingId)
        const speakers: Record<string, string> = {}
        for (const row of speakerRows) {
          if (row.contact_id) {
            const contact = getContactById(row.contact_id)
            if (contact && contact.name) {
              speakers[row.file_label] = contact.name
            }
          }
        }

        // ── 6. Parse analysis fields defensively ──────────────────────────────
        const actionItems = tryParseJson<string[]>(transcript.action_items) ?? []
        const topics = tryParseJson<string[]>(transcript.topics) ?? []
        const keyPoints = tryParseJson<string[]>(transcript.key_points) ?? []

        // ── 7. Assemble ExportData ─────────────────────────────────────────────
        const durationMs =
          typeof recording.duration_seconds === 'number'
            ? Math.round(recording.duration_seconds * 1000)
            : null

        const exportData: ExportData = {
          recording: {
            id: recording.id,
            title: recording.filename,
            dateRecorded: recording.date_recorded,
            durationMs,
            language: transcript.language,
            transcriptionProvider: transcript.transcription_provider ?? null,
            transcriptionModel: transcript.transcription_model ?? null
          },
          fullText: transcript.full_text,
          turns,
          analysis: {
            summary: transcript.summary ?? null,
            actionItems,
            topics,
            keyPoints,
            titleSuggestion: transcript.title_suggestion ?? null,
            sentiment: transcript.sentiment ?? null
          },
          speakers
        }

        // ── 8. Format the content ──────────────────────────────────────────────
        let content: string
        if (format === 'json') {
          content = toJson(exportData)
        } else if (format === 'csv') {
          content = toCsv(exportData)
        } else {
          content = toSrt(exportData)
        }

        // ── 9. Derive the default filename ────────────────────────────────────
        // Prefer the title_suggestion from analysis; fall back to filename with
        // extension stripped so we don't get "meeting.m4a.json".
        const rawTitle =
          transcript.title_suggestion && transcript.title_suggestion.trim().length > 0
            ? transcript.title_suggestion.trim()
            : stripExtension(recording.filename)

        const base = sanitizeBasename(rawTitle)
        const defaultPath = `${base}.${format}`

        // ── 10. Show native save dialog ────────────────────────────────────────
        const win = BrowserWindow.fromWebContents(event.sender)
        if (!win) {
          return error('INTERNAL_ERROR', 'No window found')
        }

        const filterMap: Record<string, Array<{ name: string; extensions: string[] }>> = {
          json: [{ name: 'JSON', extensions: ['json'] }],
          csv: [{ name: 'CSV', extensions: ['csv'] }],
          srt: [{ name: 'SRT Subtitle', extensions: ['srt'] }]
        }

        const dialogResult = await dialog.showSaveDialog(win, {
          defaultPath,
          filters: [
            ...filterMap[format],
            { name: 'All Files', extensions: ['*'] }
          ]
        })

        if (dialogResult.canceled || !dialogResult.filePath) {
          return success(null)
        }

        // ── 11. Write the file ─────────────────────────────────────────────────
        writeFileSync(dialogResult.filePath, content, 'utf-8')
        return success(dialogResult.filePath)
      } catch (err) {
        console.error('transcripts:export error:', err)
        return error('INTERNAL_ERROR', 'Failed to export transcript', err)
      }
    }
  )
}
