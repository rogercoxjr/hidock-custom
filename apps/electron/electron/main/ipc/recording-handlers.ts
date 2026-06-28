import { ipcMain, dialog, BrowserWindow } from 'electron'
import {
  getRecordings,
  getRecordingById,
  getRecordingsForMeeting,
  updateRecordingStatus,
  updateRecordingTranscriptionStatus,
  linkRecordingToMeeting,
  getTranscriptByRecordingId,
  getCandidatesForRecordingWithDetails,
  getMeetingsNearDate,
  insertRecording,
  type Recording,
  type Transcript
} from '../services/database'
import { getRecordingFiles, deleteRecording as deleteRecordingFile, getRecordingsPath } from '../services/file-storage'
import { copyFileSync, existsSync, statSync } from 'fs'
import { basename, join, extname } from 'path'
import { randomUUID } from 'crypto'
import {
  startRecordingWatcher,
  stopRecordingWatcher,
  getWatcherStatus
} from '../services/recording-watcher'
import {
  getTranscriptionStatus,
  startTranscriptionProcessor,
  stopTranscriptionProcessor,
  cancelTranscription,
  cancelAllTranscriptions,
  processQueueManually
} from '../services/transcription'
import {
  getQueueItems,
  addToQueue,
  updateQueueItem,
  clearTranscriptStage2Marker,
  clearTranscriptForRetranscribe,
  deleteRecordingSpeakersForRecording,
  deleteLabelEmbeddingsForRecording,
  deleteWindowEmbeddingsForRecording,
  expireSuggestionsForRecording,
  rependFailedItems,
  isSummaryStale,
  setTranscriptTemplateOverride
} from '../services/database'
import { validateTranscriptionConfig } from '../services/transcription-config'
import {
  GetRecordingByIdSchema,
  DeleteRecordingSchema,
  DeleteBatchRecordingsSchema,
  LinkRecordingToMeetingSchema,
  UnlinkRecordingFromMeetingSchema,
  TranscribeRecordingSchema,
  ResummarizeSchema,
  UpdateRecordingStatusSchema,
  UpdateTranscriptionStatusSchema
} from './validation'

export interface RecordingWithTranscript extends Recording {
  transcript?: Transcript
}

export function registerRecordingHandlers(): void {
  // Get all recordings
  ipcMain.handle('recordings:getAll', async (): Promise<Recording[]> => {
    try {
      return getRecordings()
    } catch (error) {
      console.error('recordings:getAll error:', error)
      return []
    }
  })

  // Get recording by ID
  ipcMain.handle('recordings:getById', async (_, id: unknown): Promise<Recording | undefined> => {
    try {
      const result = GetRecordingByIdSchema.safeParse({ id })
      if (!result.success) {
        console.error('recordings:getById validation error:', result.error)
        return undefined
      }
      return getRecordingById(result.data.id)
    } catch (error) {
      console.error('recordings:getById error:', error)
      return undefined
    }
  })

  // Get recordings for a specific meeting
  ipcMain.handle(
    'recordings:getForMeeting',
    async (_, meetingId: unknown): Promise<RecordingWithTranscript[]> => {
      try {
        // Validate meeting ID (reuse GetRecordingByIdSchema since it's the same UUID format)
        const result = GetRecordingByIdSchema.safeParse({ id: meetingId })
        if (!result.success) {
          console.error('recordings:getForMeeting validation error:', result.error)
          return []
        }

        const recordings = getRecordingsForMeeting(result.data.id)
        return recordings.map((recording) => ({
          ...recording,
          transcript: getTranscriptByRecordingId(recording.id)
        }))
      } catch (error) {
        console.error('recordings:getForMeeting error:', error)
        return []
      }
    }
  )

  // Get all recordings with their transcripts
  ipcMain.handle('recordings:getAllWithTranscripts', async (): Promise<RecordingWithTranscript[]> => {
    try {
      const recordings = getRecordings()
      return recordings.map((recording) => ({
        ...recording,
        transcript: getTranscriptByRecordingId(recording.id)
      }))
    } catch (error) {
      console.error('recordings:getAllWithTranscripts error:', error)
      return []
    }
  })

  // Delete a recording
  ipcMain.handle('recordings:delete', async (_, id: unknown): Promise<boolean> => {
    try {
      const result = DeleteRecordingSchema.safeParse({ id })
      if (!result.success) {
        console.error('recordings:delete validation error:', result.error)
        return false
      }

      const recording = getRecordingById(result.data.id)
      if (recording && recording.file_path) {
        const deleted = deleteRecordingFile(recording.file_path)
        if (deleted) {
          updateRecordingStatus(result.data.id, 'deleted')
          deleteLabelEmbeddingsForRecording(result.data.id)
          deleteWindowEmbeddingsForRecording(result.data.id)
        }
        return deleted
      }
      return false
    } catch (error) {
      console.error('recordings:delete error:', error)
      return false
    }
  })

  // Batch delete recordings (B-LIB-007)
  ipcMain.handle('recordings:deleteBatch', async (_, ids: unknown): Promise<{
    success: boolean
    deleted: number
    failed: number
    errors: Array<{ id: string; error: string }>
  }> => {
    try {
      const result = DeleteBatchRecordingsSchema.safeParse({ ids })
      if (!result.success) {
        console.error('recordings:deleteBatch validation error:', result.error)
        return { success: false, deleted: 0, failed: 0, errors: [{ id: '', error: result.error.issues[0]?.message || 'Invalid request' }] }
      }

      let deleted = 0
      let failed = 0
      const errors: Array<{ id: string; error: string }> = []

      for (const id of result.data.ids) {
        try {
          const recording = getRecordingById(id)
          if (recording && recording.file_path) {
            const wasDeleted = deleteRecordingFile(recording.file_path)
            if (wasDeleted) {
              updateRecordingStatus(id, 'deleted')
              deleteLabelEmbeddingsForRecording(id)
              deleteWindowEmbeddingsForRecording(id)
              deleted++
            } else {
              failed++
              errors.push({ id, error: 'File deletion failed' })
            }
          } else {
            failed++
            errors.push({ id, error: 'Recording not found or no file path' })
          }
        } catch (e) {
          failed++
          errors.push({ id, error: e instanceof Error ? e.message : 'Unknown error' })
        }
      }

      return { success: failed === 0, deleted, failed, errors }
    } catch (error) {
      console.error('recordings:deleteBatch error:', error)
      return { success: false, deleted: 0, failed: 0, errors: [{ id: '', error: error instanceof Error ? error.message : 'Unknown error' }] }
    }
  })

  // Link recording to meeting manually
  ipcMain.handle(
    'recordings:linkToMeeting',
    async (_, recordingId: unknown, meetingId: unknown): Promise<void> => {
      try {
        const result = LinkRecordingToMeetingSchema.safeParse({ recordingId, meetingId })
        if (!result.success) {
          console.error('recordings:linkToMeeting validation error:', result.error)
          throw new Error(result.error.issues[0]?.message || 'Invalid request')
        }

        linkRecordingToMeeting(result.data.recordingId, result.data.meetingId, 1.0, 'manual')
      } catch (error) {
        console.error('recordings:linkToMeeting error:', error)
        throw error
      }
    }
  )

  // Unlink recording from meeting
  ipcMain.handle('recordings:unlinkFromMeeting', async (_, recordingId: unknown): Promise<void> => {
    try {
      const result = UnlinkRecordingFromMeetingSchema.safeParse({ recordingId })
      if (!result.success) {
        console.error('recordings:unlinkFromMeeting validation error:', result.error)
        throw new Error(result.error.issues[0]?.message || 'Invalid request')
      }

      linkRecordingToMeeting(result.data.recordingId, '', 0, '')
    } catch (error) {
      console.error('recordings:unlinkFromMeeting error:', error)
      throw error
    }
  })

  // Get transcript for a recording
  ipcMain.handle(
    'recordings:getTranscript',
    async (_, recordingId: unknown): Promise<Transcript | undefined> => {
      try {
        const result = GetRecordingByIdSchema.safeParse({ id: recordingId })
        if (!result.success) {
          console.error('recordings:getTranscript validation error:', result.error)
          return undefined
        }

        return getTranscriptByRecordingId(result.data.id)
      } catch (error) {
        console.error('recordings:getTranscript error:', error)
        return undefined
      }
    }
  )

  // Transcribe a recording manually — routed through the queue (spec §5.7):
  // the direct transcribeManually call bypassed the mutex/retry machinery and
  // could double-bill metered ASR by racing the queue processor. Per-item
  // transcription failures surface via transcription:failed events, not this
  // promise — only infrastructure errors (lock/queue reads) reject it.
  ipcMain.handle('recordings:transcribe', async (_, recordingId: unknown): Promise<string | false> => {
    try {
      const result = TranscribeRecordingSchema.safeParse({ recordingId })
      if (!result.success) {
        console.error('recordings:transcribe validation error:', result.error)
        throw new Error(result.error.issues[0]?.message || 'Invalid request')
      }
      const id = result.data.recordingId

      // D5 §6.8 / AC6: a re-transcribe on an ALREADY-transcribed recording must
      // actually re-run FRESH ASR. The worker short-circuits when
      // `full_text && summarization_provider` are both set (transcription.ts), and
      // even with the marker NULL it would take the Stage-2-only resume path while
      // full_text is present. So BEFORE enqueueing we clear both stage markers
      // (full_text -> '', summarization_provider -> NULL, plus the diarization
      // columns) to defeat both gates, and drop the prior speaker mappings — a new
      // ASR pass re-letters speakers, so old label->contact maps no longer apply.
      // A FIRST-TIME transcribe (no transcript row) skips both: clearTranscriptForRetranscribe
      // is a no-op without a row, and we only drop mappings when re-transcribing.
      const existingTranscript = getTranscriptByRecordingId(id)
      if (existingTranscript?.full_text) {
        clearTranscriptForRetranscribe(id)
        deleteRecordingSpeakersForRecording(id)
        deleteLabelEmbeddingsForRecording(id)
        deleteWindowEmbeddingsForRecording(id)
        expireSuggestionsForRecording(id)
      }

      // Return the queue-item id so the renderer (queueTranscription's forced
      // re-transcribe branch) can feed the in-app queue panel, mirroring addToQueue.
      const queueItemId = addToQueue(id)
      await processQueueManually()
      return queueItemId
    } catch (error) {
      console.error('recordings:transcribe error:', error)
      throw error
    }
  })

  // Get watcher status
  ipcMain.handle(
    'recordings:getWatcherStatus',
    async (): Promise<{ isWatching: boolean; path: string }> => {
      return getWatcherStatus()
    }
  )

  // Start/stop watcher
  ipcMain.handle('recordings:startWatcher', async (): Promise<void> => {
    startRecordingWatcher()
  })

  ipcMain.handle('recordings:stopWatcher', async (): Promise<void> => {
    stopRecordingWatcher()
  })

  // Get transcription status
  ipcMain.handle(
    'recordings:getTranscriptionStatus',
    async (): Promise<{
      isProcessing: boolean
      pendingCount: number
      processingCount: number
    }> => {
      return getTranscriptionStatus()
    }
  )

  // Start/stop transcription processor
  ipcMain.handle('recordings:startTranscriptionProcessor', async (): Promise<void> => {
    startTranscriptionProcessor()
  })

  ipcMain.handle('recordings:stopTranscriptionProcessor', async (): Promise<void> => {
    stopTranscriptionProcessor()
  })

  ipcMain.handle('transcription:cancel', async (_, recordingId: string): Promise<{ success: boolean }> => {
    try {
      cancelTranscription(recordingId)
      return { success: true }
    } catch (error) {
      console.error('transcription:cancel error:', error)
      return { success: false }
    }
  })

  ipcMain.handle('transcription:cancelAll', async (): Promise<{ success: boolean; count: number }> => {
    try {
      const count = cancelAllTranscriptions()
      return { success: true, count }
    } catch (error) {
      console.error('transcription:cancelAll error:', error)
      return { success: false, count: 0 }
    }
  })

  // Retry-all failed transcriptions (spec §7.3): re-pend provider-terminal failures
  // using all three provider markers so the user need not know which provider failed.
  // Deterministic failures (file not found, disk-space, ffmpeg) are excluded BY
  // CONSTRUCTION — their error messages match none of the provider markers.
  ipcMain.handle('transcription:retryAll', async (): Promise<{ success: boolean; count: number }> => {
    try {
      const count = rependFailedItems(['OpenAI', 'Ollama Cloud', 'Gemini API key', 'AssemblyAI'])
      if (count > 0) {
        void processQueueManually()
      }
      return { success: true, count }
    } catch (error) {
      console.error('transcription:retryAll error:', error)
      return { success: false, count: 0 }
    }
  })

  // Provider-aware preflight (spec §5.6): which selected providers lack keys.
  // Replaces the renderer's hardcoded Gemini-key gates (useOperations).
  // Body lives in the shared validateTranscriptionConfig() so addToQueue reuses
  // the exact same gate (single source of truth).
  ipcMain.handle('transcription:validateConfig', async (): Promise<{
    ok: boolean
    // Union per spec §5.6. Only 'missing-key' is emitted by the preflight in v1 —
    // 'rejected-key' is detected at call time (§7.1 ProviderAuthError) and via the
    // Settings Test button; the type carries it so consumers handle both.
    problems: Array<{ stage: 'asr' | 'summarization'; provider: string; problem: 'missing-key' | 'rejected-key' }>
  }> => {
    return validateTranscriptionConfig()
  })

  // Re-summarize (spec §5.3/§5.6): clear the stage marker (keeping the old summary)
  // and enqueue — the worker's resume rule runs Stage 2 only, no audio file needed.
  // Phase 4 (Task 13): concurrency guard (spec §8.3 — reject-if-in-flight, no last-write-wins)
  // + single-shot templateId override write.  Bare-string wrap kept for the existing renderer
  // caller (preload transcription.resummarize passes a bare recordingId string).
  ipcMain.handle('transcription:resummarize', async (_, payload: unknown): Promise<{ success: boolean; error?: string }> => {
    try {
      const normalized =
        typeof payload === 'object' && payload !== null && 'recordingId' in payload
          ? payload
          : { recordingId: payload }
      const result = ResummarizeSchema.safeParse(normalized)
      if (!result.success) throw new Error(result.error.issues[0]?.message || 'Invalid request')
      const { recordingId, templateId } = result.data
      // §8.3 transcript-existence guard — block only when no transcript exists yet.
      // Re-summarize is Stage-2-only; it must not be blocked by a parked Stage-1 queue item.
      const existingForGuard = getTranscriptByRecordingId(recordingId)
      if (!existingForGuard || !existingForGuard.full_text || !existingForGuard.full_text.trim()) {
        return { success: false, error: 'No transcript to summarize yet — transcribe this recording first.' }
      }
      // FIX 3: ALWAYS reset the single-shot override to the requested value (null when
      // none requested). The success-path nulling lives in updateTranscriptStage2, so a
      // FAILED Stage-2 leaves a stale override behind; without this a later plain
      // re-summarize would silently re-apply that template. Setting null here starts
      // every plain re-summarize from a clean selector/Default state.
      setTranscriptTemplateOverride(recordingId, templateId ?? null)
      clearTranscriptStage2Marker(recordingId)
      addToQueue(recordingId)
      void processQueueManually()
      return { success: true }
    } catch (error) {
      console.error('transcription:resummarize error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // D5 §6.6: staleness probe for the "generic speaker labels" badge — true once
  // a mapping post-dates the summary, false after a names-attributing resummarize.
  ipcMain.handle('transcription:isSummaryStale', async (_, recordingId: unknown): Promise<boolean> => {
    try {
      const result = TranscribeRecordingSchema.safeParse({ recordingId })
      if (!result.success) return false
      return isSummaryStale(result.data.recordingId)
    } catch (error) {
      console.error('transcription:isSummaryStale error:', error)
      return false
    }
  })

  ipcMain.handle('transcription:getQueue', async (): Promise<any[]> => {
    try {
      return getQueueItems()
    } catch (error) {
      console.error('transcription:getQueue error:', error)
      return []
    }
  })

  ipcMain.handle('transcription:updateQueueItem', async (_, id: string, status: string, errorMessage?: string): Promise<boolean> => {
    try {
      updateQueueItem(id, status, errorMessage)
      return true
    } catch (error) {
      console.error('transcription:updateQueueItem error:', error)
      return false
    }
  })

  // Scan recordings folder
  ipcMain.handle('recordings:scanFolder', async (): Promise<string[]> => {
    return getRecordingFiles()
  })

  // Get meeting candidates for a recording (for manual linking)
  ipcMain.handle('recordings:getCandidates', async (_, recordingId: unknown) => {
    try {
      const result = GetRecordingByIdSchema.safeParse({ id: recordingId })
      if (!result.success) {
        console.error('recordings:getCandidates validation error:', result.error)
        return { success: false, data: [], error: 'Invalid recording ID' }
      }
      const data = getCandidatesForRecordingWithDetails(result.data.id)
      return { success: true, data }
    } catch (error) {
      console.error('recordings:getCandidates error:', error)
      return { success: false, data: [], error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // Get meetings near a specific date (for manual linking)
  ipcMain.handle('recordings:getMeetingsNearDate', async (_, dateStr: unknown) => {
    try {
      if (typeof dateStr !== 'string') {
        console.error('recordings:getMeetingsNearDate invalid date:', dateStr)
        return { success: false, data: [], error: 'Invalid date' }
      }
      const data = getMeetingsNearDate(dateStr)
      return { success: true, data }
    } catch (error) {
      console.error('recordings:getMeetingsNearDate error:', error)
      return { success: false, data: [], error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // Add external recording (from file dialog)
  ipcMain.handle('recordings:addExternal', async (): Promise<{ success: boolean; recording?: Recording; error?: string }> => {
    try {
      // Get the focused window for the dialog parent
      const focusedWindow = BrowserWindow.getFocusedWindow()

      // Open file dialog to select an audio file
      const result = await dialog.showOpenDialog(focusedWindow || BrowserWindow.getAllWindows()[0], {
        title: 'Select Audio File',
        filters: [
          { name: 'Audio Files', extensions: ['mp3', 'm4a', 'wav', 'ogg', 'flac'] }
        ],
        properties: ['openFile']
      })

      // Check if user cancelled the dialog
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, error: 'No file selected' }
      }

      const sourcePath = result.filePaths[0]

      // Check if file exists
      if (!existsSync(sourcePath)) {
        return { success: false, error: 'Selected file does not exist' }
      }

      // Get file stats
      const stats = statSync(sourcePath)
      const originalFilename = basename(sourcePath)
      const fileExtension = extname(originalFilename)

      // Generate a unique filename for the recordings folder
      const recordingsPath = getRecordingsPath()
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')
      const newFilename = `external-${timestamp[0]}-${timestamp[1].substring(0, 8)}${fileExtension}`
      const destinationPath = join(recordingsPath, newFilename)

      // Copy the file to the recordings folder
      copyFileSync(sourcePath, destinationPath)

      // Create database entry
      const recordingId = randomUUID()

      const recording: Omit<Recording, 'created_at'> = {
        id: recordingId,
        filename: newFilename,
        original_filename: originalFilename,
        file_path: destinationPath,
        file_size: stats.size,
        duration_seconds: undefined, // Will be populated later if needed
        date_recorded: stats.mtime.toISOString(),
        meeting_id: undefined,
        correlation_confidence: undefined,
        correlation_method: undefined,
        status: 'ready',
        location: 'local-only',
        transcription_status: 'none',
        on_device: 0,
        device_last_seen: undefined,
        on_local: 1,
        source: 'external',
        is_imported: 1
      }

      insertRecording(recording)

      // Get the full recording with created_at timestamp
      const insertedRecording = getRecordingById(recordingId)

      if (!insertedRecording) {
        return { success: false, error: 'Failed to retrieve recording after insert' }
      }

      return { success: true, recording: insertedRecording }
    } catch (error) {
      console.error('recordings:addExternal error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      }
    }
  })

  // Add external recording by file path (used by drag-and-drop import)
  ipcMain.handle('recordings:addExternalByPath', async (_, filePath: string): Promise<{ success: boolean; recording?: Recording; error?: string }> => {
    try {
      // Validate file extension
      const allowedExtensions = ['.mp3', '.m4a', '.wav', '.ogg', '.flac', '.webm', '.hda']
      const fileExtension = extname(filePath).toLowerCase()
      if (!allowedExtensions.includes(fileExtension)) {
        return { success: false, error: `Unsupported file type: ${fileExtension}. Supported: ${allowedExtensions.join(', ')}` }
      }

      // Check if file exists
      if (!existsSync(filePath)) {
        return { success: false, error: 'File does not exist' }
      }

      // Get file stats
      const stats = statSync(filePath)
      const originalFilename = basename(filePath)

      // Generate a unique filename for the recordings folder
      const recordingsPath = getRecordingsPath()
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')
      const newFilename = `external-${timestamp[0]}-${timestamp[1].substring(0, 8)}${fileExtension}`
      const destinationPath = join(recordingsPath, newFilename)

      // Copy the file to the recordings folder
      copyFileSync(filePath, destinationPath)

      // Create database entry
      const recordingId = randomUUID()

      const recording: Omit<Recording, 'created_at'> = {
        id: recordingId,
        filename: newFilename,
        original_filename: originalFilename,
        file_path: destinationPath,
        file_size: stats.size,
        duration_seconds: undefined,
        date_recorded: stats.mtime.toISOString(),
        meeting_id: undefined,
        correlation_confidence: undefined,
        correlation_method: undefined,
        status: 'ready',
        location: 'local-only',
        transcription_status: 'none',
        on_device: 0,
        device_last_seen: undefined,
        on_local: 1,
        source: 'external',
        is_imported: 1
      }

      insertRecording(recording)

      const insertedRecording = getRecordingById(recordingId)
      if (!insertedRecording) {
        return { success: false, error: 'Failed to retrieve recording after insert' }
      }

      return { success: true, recording: insertedRecording }
    } catch (error) {
      console.error('recordings:addExternalByPath error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      }
    }
  })

  // Select a meeting for a recording (manual linking from dialog)
  ipcMain.handle('recordings:selectMeeting', async (_, recordingId: string, meetingId: string | null) => {
    try {
      if (meetingId) {
        linkRecordingToMeeting(recordingId, meetingId, 1.0, 'manual')
      } else {
        linkRecordingToMeeting(recordingId, '', 0, '')
      }
      return { success: true }
    } catch (error) {
      console.error('recordings:selectMeeting error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // Add a recording to the transcription queue
  ipcMain.handle('recordings:addToQueue', async (_, recordingId: string) => {
    try {
      // Validate the SELECTED providers' keys before queueing, via the shared
      // gate (spec §5.6). This is provider-aware: a Whisper+Ollama user queues
      // without a Gemini key, and a Whisper user without an OpenAI key is
      // rejected — the previous untrimmed Gemini-only check did the opposite and
      // would silently false-succeed once P3 wires Ollama summarization.
      if (!validateTranscriptionConfig().ok) {
        return {
          success: false,
          error: 'Transcription API key not configured. Please add your API key in Settings.'
        }
      }

      const queueItemId = addToQueue(recordingId)
      updateRecordingTranscriptionStatus(recordingId, 'queued')
      // spec-005: Trigger immediate queue processing after adding
      processQueueManually()
      return queueItemId
    } catch (error) {
      console.error('recordings:addToQueue error:', error)
      return false
    }
  })

  // Start processing the transcription queue
  ipcMain.handle('recordings:processQueue', async () => {
    try {
      startTranscriptionProcessor()
      return true
    } catch (error) {
      console.error('recordings:processQueue error:', error)
      return false
    }
  })

  // spec-005: Retry a failed transcription
  ipcMain.handle('transcription:retry', async (_, recordingId: string) => {
    try {
      const result = TranscribeRecordingSchema.safeParse({ recordingId })
      if (!result.success) {
        console.error('transcription:retry validation error:', result.error)
        return { success: false, error: result.error.issues[0]?.message || 'Invalid request' }
      }

      const queueItemId = addToQueue(result.data.recordingId)
      updateRecordingTranscriptionStatus(result.data.recordingId, 'pending')
      processQueueManually()
      return { success: true, queueItemId }
    } catch (error) {
      console.error('transcription:retry error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // Update recording status
  ipcMain.handle('recordings:updateStatus', async (_, id: unknown, status: unknown): Promise<{ success: boolean; data?: Recording; error?: string }> => {
    try {
      const result = UpdateRecordingStatusSchema.safeParse({ id, status })
      if (!result.success) {
        console.error('recordings:updateStatus validation error:', result.error)
        return { success: false, error: result.error.issues[0]?.message || 'Invalid request parameters' }
      }
      updateRecordingStatus(result.data.id, result.data.status)
      const recording = getRecordingById(result.data.id)
      if (!recording) {
        return { success: false, error: 'Recording not found after status update' }
      }
      return { success: true, data: recording }
    } catch (error) {
      console.error('recordings:updateStatus error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error occurred' }
    }
  })

  // Update transcription status
  ipcMain.handle('recordings:updateTranscriptionStatus', async (_, id: unknown, status: unknown): Promise<{ success: boolean; data?: Recording; error?: string }> => {
    try {
      const result = UpdateTranscriptionStatusSchema.safeParse({ id, status })
      if (!result.success) {
        console.error('recordings:updateTranscriptionStatus validation error:', result.error)
        return { success: false, error: result.error.issues[0]?.message || 'Invalid request parameters' }
      }
      updateRecordingTranscriptionStatus(result.data.id, result.data.status)
      const recording = getRecordingById(result.data.id)
      if (!recording) {
        return { success: false, error: 'Recording not found after transcription status update' }
      }
      return { success: true, data: recording }
    } catch (error) {
      console.error('recordings:updateTranscriptionStatus error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error occurred' }
    }
  })

  console.log('Recording IPC handlers registered')
}
