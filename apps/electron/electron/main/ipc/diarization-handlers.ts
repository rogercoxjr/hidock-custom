/**
 * Diarization-run instrumentation IPC handlers (Voice Library Phase 2C).
 *
 * Read-only accessors for the diarization_runs table; writes happen from the
 * transcription service during Stage 1 of a diarizing ASR pass.
 */

import { ipcMain } from 'electron'
import { getLatestDiarizationRun, getDiarizationRunsForRecording, type DiarizationRun } from '../services/database'
import { success, error, type Result } from '../types/api'
import { z } from 'zod'

const RecordingIdSchema = z.string().min(1)

export function registerDiarizationHandlers(): void {
  /**
   * Return the most recent diarization run for a recording, including the options
   * sent, label count, solo flag, and failure reason.
   */
  ipcMain.handle(
    'diarization:getLatestRun',
    async (_, recordingId: unknown): Promise<Result<DiarizationRun | null>> => {
      try {
        const parsed = RecordingIdSchema.safeParse(recordingId)
        if (!parsed.success) {
          return error('VALIDATION_ERROR', 'Invalid recordingId', parsed.error.format())
        }
        const run = getLatestDiarizationRun(parsed.data) ?? null
        return success(run)
      } catch (err) {
        console.error('diarization:getLatestRun error:', err)
        return error('DATABASE_ERROR', 'Failed to load latest diarization run', err)
      }
    }
  )

  /**
   * Return every diarization run for a recording, newest first.
   */
  ipcMain.handle(
    'diarization:getRunsForRecording',
    async (_, recordingId: unknown): Promise<Result<DiarizationRun[]>> => {
      try {
        const parsed = RecordingIdSchema.safeParse(recordingId)
        if (!parsed.success) {
          return error('VALIDATION_ERROR', 'Invalid recordingId', parsed.error.format())
        }
        const runs = getDiarizationRunsForRecording(parsed.data)
        return success(runs)
      } catch (err) {
        console.error('diarization:getRunsForRecording error:', err)
        return error('DATABASE_ERROR', 'Failed to load diarization runs', err)
      }
    }
  )
}
