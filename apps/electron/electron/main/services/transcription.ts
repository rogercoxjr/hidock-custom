import { existsSync } from 'fs'
import { getConfig } from './config'
import {
  getRecordingById,
  getTranscriptByRecordingId,
  upsertTranscriptStage1,
  updateTranscriptStage2,
  updateRecordingTranscriptionStatus,
  getQueueItems,
  getRunnableQueueItems,
  parkQueueItem,
  clearParking,
  getQueueItemParkedHours,
  updateQueueItem,
  updateQueueProgress,
  getMeetingById,
  findCandidateMeetingsForRecording,
  addRecordingMeetingCandidate,
  linkRecordingToMeeting,
  updateKnowledgeCaptureTitle,
  removeFromQueueByRecordingId,
  cancelPendingTranscriptions,
  run,
  queryOne,
  acquireTranscriptionLock,
  releaseTranscriptionLock,
  clearStaleTranscriptionLock,
  resetStuckTranscriptions,
  buildAttributedTranscript,
  deleteRecordingSpeakersForRecording
} from './database'
import { getAsrProvider } from './asr/asr-provider'
import { getLlmProvider, type LlmProvider } from './llm/llm-provider'
import { ProviderRateLimitError } from './provider-errors'
import { BrowserWindow } from 'electron'
import { getVectorStore } from './vector-store'

let mainWindow: BrowserWindow | null = null
let isProcessing = false
let processingInterval: ReturnType<typeof setInterval> | null = null
let lastSkipLogAt = 0 // Throttle "skipping" spam to once per 60s

export function setMainWindowForTranscription(win: BrowserWindow): void {
  mainWindow = win
}

export function startTranscriptionProcessor(): void {
  if (processingInterval) {
    console.log('Transcription processor already running')
    return
  }

  clearStaleTranscriptionLock()
  resetStuckTranscriptions()

  console.log('Starting transcription processor')

  // Process queue every 10 seconds
  processingInterval = setInterval(() => {
    processQueue()
  }, 10000)

  // Start immediately
  processQueue()
}

export function stopTranscriptionProcessor(): void {
  if (processingInterval) {
    clearInterval(processingInterval)
    processingInterval = null
    console.log('Transcription processor stopped')
  }
}

let cancelRequested = false

export function cancelTranscription(recordingId: string): void {
  removeFromQueueByRecordingId(recordingId)
  updateRecordingTranscriptionStatus(recordingId, 'none')
  notifyRenderer('transcription:cancelled', { recordingId })
}

export function cancelAllTranscriptions(): number {
  cancelRequested = true
  const count = cancelPendingTranscriptions()
  notifyRenderer('transcription:all-cancelled', { count })
  // cancelRequested is reset at the end of processQueue (after the loop breaks)
  // rather than on a timer, to avoid the race where the flag resets before
  // processQueue has a chance to observe it.
  return count
}

const MAX_RETRY_ATTEMPTS = 3 // spec-014: configurable max retry attempts

async function processQueue(): Promise<void> {
  if (isProcessing) return

  // spec-005: Acquire mutex lock to prevent concurrent processing
  const processId = `proc_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
  const lockAcquired = acquireTranscriptionLock(processId)
  if (!lockAcquired) {
    // Throttle to once per 60s — this fires every 10s during active transcription, which is expected
    const now = Date.now()
    if (now - lastSkipLogAt > 60000) {
      console.log('[Transcription] Another process is already processing the queue, skipping')
      lastSkipLogAt = now
    }
    return
  }

  try {
    // Auto-pipeline P1 (spec §5.3): the queue-level Gemini key pre-check is
    // GONE. Per-stage provider factories (getAsrProvider / getLlmProvider) throw
    // the canonical 'Gemini API key not configured' string at construction, so a
    // missing key now fails each item one-by-one as it is processed (same
    // terminal state, still matched by NON_RETRYABLE_ERRORS) instead of being
    // mass-marked here. This is spec AC7's one deliberate exception (b).
    // spec-014: Retry failed items with max attempts
    // B-TXN-001: Exponential backoff before retrying failed items
    // C-005: Skip non-retryable errors (missing files, missing API key)
    const NON_RETRYABLE_ERRORS = [
      'Recording not found',
      'Recording file not found',
      'Gemini API key not configured',
      'OpenAI API key not configured',
      'AssemblyAI API key not configured',
      'Ollama Cloud API key not configured',
      'Not enough disk space',
      'API key was rejected',
      'quota exhausted',
      'quota still exhausted after 24h',
      'ffmpeg failed',
      'no local file',
      'not found — choose a new model'
    ]
    const failedItems = getQueueItems('failed')
    const now = Date.now()
    for (const item of failedItems) {
      // B-TXN-003: Use typed property access instead of `as any` cast
      const retryCount = item.retry_count ?? 0

      // C-005: Don't retry items whose error indicates a permanent failure
      const errorMsg = item.error_message || ''
      const isNonRetryable = NON_RETRYABLE_ERRORS.some(pattern => errorMsg.includes(pattern))
      if (isNonRetryable) {
        continue
      }

      if (retryCount < MAX_RETRY_ATTEMPTS) {
        // B-TXN-001: Calculate backoff delay: 30s * 2^retryCount, capped at 120s
        const backoffMs = Math.min(30000 * Math.pow(2, retryCount), 120000)
        const completedAt = item.completed_at ? new Date(item.completed_at).getTime() : 0
        const timeSinceFailure = now - completedAt

        if (timeSinceFailure < backoffMs) {
          // Not enough time has passed; skip this retry cycle
          console.log(`[Transcription] Backoff for ${item.id}: waiting ${Math.round((backoffMs - timeSinceFailure) / 1000)}s more (retry ${retryCount + 1}/${MAX_RETRY_ATTEMPTS})`)
          continue
        }

        // Reset to pending so it gets picked up in the processing loop
        updateQueueItem(item.id, 'pending')
        // Also reset recording status so UI shows it's retrying
        updateRecordingTranscriptionStatus(item.recording_id, 'pending')
        console.log(`Re-queuing failed item ${item.id} (retry ${retryCount + 1}/${MAX_RETRY_ATTEMPTS}, backoff ${backoffMs / 1000}s)`)
      }
    }

    // Auto-pipeline P4 (spec §7.2): the poller selects RUNNABLE pending items —
    // those not parked into the future. Parked items keep status='pending' so
    // dedupe/startup-recovery/re-pend stay correct, but the runnable filter hides
    // them until parked_until passes. Everything else still uses getQueueItems.
    const pendingItems = getRunnableQueueItems()
    if (pendingItems.length === 0) {
      return
    }

    isProcessing = true

    for (const item of pendingItems) {
      if (cancelRequested) {
        console.log('Transcription cancelled by user')
        break
      }

      try {
        updateQueueItem(item.id, 'processing')
        updateQueueProgress(item.id, 0) // spec-014: reset progress
        notifyRenderer('transcription:started', { queueItemId: item.id, recordingId: item.recording_id })
        const { emitActivityLog } = await import('./activity-log')
        const recording = getRecordingById(item.recording_id)
        const filename = recording?.filename ?? item.recording_id
        emitActivityLog('info', 'Transcribing recording', filename)

        // B-TXN-002: Progress ticker that increments during long API calls
        // instead of being stuck at a hardcoded value
        let tickerProgress = 0
        const progressTicker = setInterval(() => {
          // Tick progress upward during API calls, capping below 95% (reserved for completion)
          if (tickerProgress < 90) {
            tickerProgress += 2
            updateQueueProgress(item.id, tickerProgress)
            notifyRenderer('transcription:progress', {
              queueItemId: item.id,
              recordingId: item.recording_id,
              stage: 'transcribing',
              progress: tickerProgress
            })
          }
        }, 3000)

        // spec-014: Progress callback for transcription stages
        const progressCallback = (stage: string, progress: number) => {
          tickerProgress = progress // Sync ticker with actual progress
          // Auto-pipeline P4 (spec §7.2): parking clears on any successful STAGE
          // completion, not just job completion — so a Stage-1 (e.g. Whisper) park
          // history can never poison the 24h clock of a later Stage-2 (e.g. Ollama)
          // 429. The clear must key on a GENUINE Stage-1-completed-this-run signal
          // ('stage1_complete', emitted only AFTER the ASR write), NOT the shared
          // 'analyzing' label: a Stage-2-only resume fires 'analyzing' at its START
          // (before the LLM call) and completes nothing this run — clearing there
          // would reset first_parked_at on every park-expiry, making the 24h
          // terminal cap unreachable for Stage-2 429s (the spec's primary 429
          // source). 'stage1_complete' is an internal marker; the renderer still
          // sees 'analyzing'/50 (its progress contract is unchanged — it never
          // reads `stage`).
          const reportedStage = stage === 'stage1_complete' ? 'analyzing' : stage
          if (stage === 'stage1_complete') {
            clearParking(item.id)
          }
          updateQueueProgress(item.id, progress)
          notifyRenderer('transcription:progress', {
            queueItemId: item.id,
            recordingId: item.recording_id,
            stage: reportedStage,
            progress
          })
        }

        try {
          await transcribeRecording(item.recording_id, progressCallback)
        } finally {
          clearInterval(progressTicker) // Always clean up the ticker
        }

        updateQueueProgress(item.id, 100) // spec-014: mark complete
        updateQueueItem(item.id, 'completed')
        clearParking(item.id) // Auto-pipeline P4 (spec §7.2): clear parking on success
        notifyRenderer('transcription:completed', { queueItemId: item.id, recordingId: item.recording_id })
        const { emitActivityLog: emitDone } = await import('./activity-log')
        const recDone = getRecordingById(item.recording_id)
        emitDone('success', 'Transcription complete', recDone?.filename ?? item.recording_id)
      } catch (error) {
        // Auto-pipeline P4 (spec §7.1/§7.2): failure taxonomy BEFORE the generic
        // failure path. A typed 429 (ProviderRateLimitError) is "parked" — quota
        // windows are hours-long while the retry budget burns in ~4 minutes — so
        // we park without burning retry_count, UNLESS the item has already been
        // parked for over 24h, in which case it terminal-fails (§7.1). Auth (401)
        // and quota-exhausted errors are plain Errors whose messages are in
        // NON_RETRYABLE_ERRORS, so they fall through to the generic terminal path.
        if (error instanceof ProviderRateLimitError) {
          // 24h age is computed in SQL (getQueueItemParkedHours) — never Date-parse
          // the space-format first_parked_at column (V8 reads it as LOCAL time).
          const parkedHours = getQueueItemParkedHours(item.id)
          if (parkedHours !== null && parkedHours > 24) {
            const msg = `${error.provider} quota still exhausted after 24h — check your plan, then Retry all` // §7.1
            updateQueueItem(item.id, 'failed', msg)
            updateRecordingTranscriptionStatus(item.recording_id, 'error')
            notifyRenderer('transcription:failed', {
              queueItemId: item.id,
              recordingId: item.recording_id,
              error: msg
            })
          } else {
            const delayMs = error.retryAfterMs ?? 30 * 60 * 1000 // Retry-After else 30 min (spec §7.2)
            parkQueueItem(item.id, delayMs)
            // Parking is SILENT — reset the recording to 'pending' (not 'error') and
            // do NOT emit transcription:failed (the chip counts FAILED rows only).
            updateRecordingTranscriptionStatus(item.recording_id, 'pending')
            console.log(
              `[Transcription] Parked ${item.id} for ${Math.round(delayMs / 1000)}s (${error.provider} 429)`
            )
          }
          continue
        }

        const errorMessage = error instanceof Error ? error.message : 'Unknown error'
        console.error('Transcription failed:', errorMessage)

        updateQueueItem(item.id, 'failed', errorMessage)
        // AI-13: Use standard enum value 'error' (not 'failed')
        updateRecordingTranscriptionStatus(item.recording_id, 'error')
        notifyRenderer('transcription:failed', {
          queueItemId: item.id,
          recordingId: item.recording_id,
          error: errorMessage
        })
        const { emitActivityLog: emitFail } = await import('./activity-log')
        const recFail = getRecordingById(item.recording_id)
        emitFail('error', 'Transcription failed', `${recFail?.filename ?? item.recording_id}: ${errorMessage}`)

        // B-TXN-003: Use typed property access instead of `as any` cast
        const retryCount = item.retry_count ?? 0
        if (retryCount >= MAX_RETRY_ATTEMPTS) {
          console.log(`Recording ${item.recording_id} failed after ${retryCount} retries (max: ${MAX_RETRY_ATTEMPTS})`)
        }
      }
    }

    isProcessing = false
    // AI-11: Reset cancel flag after loop exits, not on a timer
    cancelRequested = false
  } finally {
    // spec-005: Always release mutex lock, even if an error occurred
    releaseTranscriptionLock(processId)
  }
}

/**
 * spec-005: Manually trigger queue processing (exported for IPC handlers).
 * Call after adding items to the queue for immediate processing.
 */
export async function processQueueManually(): Promise<void> {
  return processQueue()
}

interface ActionableDetection {
  type: 'meeting_minutes' | 'interview_feedback' | 'status_report' |
        'decision_log' | 'action_items' | 'research_summary'
  confidence: number // 0.0 to 1.0
  suggestedTitle: string
  reason: string // Why detected
  suggestedTemplate?: string
  suggestedRecipients?: string[]
}

/**
 * Returns the detections, or `null` when the detection LLM call FAILED —
 * distinct from `[]`, which means detection ran (or deliberately skipped a
 * <100-word transcript) and there is nothing to create. The caller gates the
 * pending-actionables delete-and-replace on a non-null return: a transient LLM
 * failure must never wipe previously-created pending cards with nothing to
 * replace them.
 */
async function detectActionables(
  llm: LlmProvider,
  transcriptText: string,
  knowledgeCaptureId: string,
  metadata: { title?: string; questions?: string[] }
): Promise<ActionableDetection[] | null> {
  // Auto-pipeline P1 (spec §5.3): the LLM provider is constructed once in
  // Stage 2 and passed in here — its key check already happened at the factory.
  // The own GoogleGenerativeAI construction + key early-return are gone; a
  // failure now lands in the catch below (graceful skip — unchanged).

  // Skip very short transcripts
  const wordCount = transcriptText.split(/\s+/).filter(w => w.length > 0).length
  if (wordCount < 100) {
    console.log('[Actionable Detection] Transcript too short (<100 words), skipping')
    return []
  }

  // Truncate very long transcripts to last 5000 words
  const words = transcriptText.split(/\s+/)
  const truncatedText = words.length > 5000 ? words.slice(-5000).join(' ') : transcriptText

  const prompt = `Analyze this meeting transcript and detect if the speaker intends to create any outputs or documents.

Transcript:
${truncatedText}

Meeting Title: ${metadata.title || 'Unknown'}
Questions: ${metadata.questions?.join(', ') || 'None'}

Detect if speaker mentions need to:
1. Send meeting minutes/notes
2. Write interview feedback/evaluation
3. Create status report/update
4. Document decisions
5. Share action items
6. Compile research/findings

For each detected intent, return:
- type: The type of actionable (meeting_minutes, interview_feedback, status_report, decision_log, action_items, research_summary)
- confidence: 0.0-1.0 (how confident you are)
- suggestedTitle: Brief title for the actionable (e.g., "Send meeting notes to team")
- reason: Why you detected this (quote from transcript)
- suggestedTemplate: Template name to use (e.g., "meeting_minutes", "interview_feedback")
- suggestedRecipients: Who should receive it (if mentioned)

Return as JSON array. If no actionables detected, return empty array [].
Only include detections with confidence >= 0.6.`

  try {
    const responseText = await llm.generate(prompt, { json: true })

    // Extract JSON from response (might be wrapped in markdown code blocks)
    const jsonMatch = responseText.match(/\[[\s\S]*\]/)
    if (!jsonMatch) {
      console.log('[Actionable Detection] No JSON array found in response')
      return []
    }

    const detections = JSON.parse(jsonMatch[0]) as ActionableDetection[]

    // Filter out low-confidence detections
    const filtered = detections.filter(d => d.confidence >= 0.6)
    console.log(`[Actionable Detection] Detected ${filtered.length} actionables for ${knowledgeCaptureId}`)

    return filtered
  } catch (error) {
    console.error('[Actionable Detection] Failed:', error)
    // Fail gracefully — null tells the caller the run FAILED (do not clear
    // existing pending actionables), as opposed to [] = ran and found none.
    return null
  }
}

async function transcribeRecording(
  recordingId: string,
  progressCallback?: (stage: string, progress: number) => void
): Promise<void> {
  const recording = getRecordingById(recordingId)
  if (!recording) {
    // 'Recording not found' must stay a substring — it is in NON_RETRYABLE_ERRORS.
    throw new Error(`Recording not found: ${recordingId}`)
  }

  const config = getConfig()
  const existing = getTranscriptByRecordingId(recordingId)

  // Short-circuit (spec §5.3): both stages done -> duplicate queue items are no-ops.
  if (existing?.full_text && existing.summarization_provider) {
    console.log(`[Transcription] ${recordingId} already fully transcribed — short-circuit`)
    updateRecordingTranscriptionStatus(recordingId, 'complete')
    return
  }

  console.log(`Transcribing: ${recording.filename}`)
  // AI-13: Use standard enum values matching Recording.transcription_status
  updateRecordingTranscriptionStatus(recordingId, 'processing')

  // Find candidate meetings for this recording's time window
  const candidateMeetings = findCandidateMeetingsForRecording(recordingId)
  console.log(`Found ${candidateMeetings.length} candidate meetings for recording ${recordingId}`)

  // Resume rule (spec §5.3): full_text set + marker NULL -> run Stage 2 only.
  const stage2Only = Boolean(existing?.full_text && !existing.summarization_provider)
  let fullText: string

  if (stage2Only) {
    // Stage-2-only run (resume / resummarize): needs only full_text — no audio file.
    fullText = existing!.full_text
    progressCallback?.('analyzing', 50)
  } else {
    // ===== Stage 1: ASR =====
    // File-existence checks are Stage-1-only (spec §5.3).
    if (!recording.file_path) {
      // 'no local file' must stay a substring — it is in NON_RETRYABLE_ERRORS.
      throw new Error(`Recording has no local file: ${recordingId}`)
    }
    if (!existsSync(recording.file_path)) {
      throw new Error(`Recording file not found: ${recording.file_path}`)
    }

    progressCallback?.('reading_file', 5) // spec-014: progress reporting

    // D5 §6.8: a NEW ASR pass may re-letter speakers (AssemblyAI labels are
    // per-job), so prior label->contact mappings no longer apply. Drop them
    // here — at the START of Stage 1 — so AC3 holds (no orphaned rows) even if
    // the ASR call later fails. Stage-2-only resumes/resummarize never reach
    // this branch, so their mappings survive. Voiceprints are per-contact and
    // are NOT dropped.
    deleteRecordingSpeakersForRecording(recordingId)

    // Build meeting context for better transcription
    let meetingContext = ''
    if (candidateMeetings.length > 0) {
      meetingContext = `\n\nPOSSIBLE MEETING CONTEXT (use this to improve transcription accuracy):
${candidateMeetings.map((m, i) => `
Meeting ${i + 1}: "${m.subject}"
  Time: ${new Date(m.start_time).toLocaleString()} - ${new Date(m.end_time).toLocaleString()}
  ${m.organizer_name ? `Organizer: ${m.organizer_name}` : ''}
  ${m.location ? `Location: ${m.location}` : ''}
  ${m.description ? `Description: ${m.description.slice(0, 200)}...` : ''}
`).join('\n')}`
    }

    progressCallback?.('transcribing', 20) // spec-014: progress reporting

    // Stage-1 key check: getAsrProvider throws the canonical key-missing string.
    const asr = getAsrProvider(config)
    const asrResult = await asr.transcribe(recording.file_path, { meetingContext })
    fullText = asrResult.text

    // Stage-1 write: never touches Stage-2 columns (spec §5.3).
    const stage1WordCount = fullText.split(/\s+/).filter((w) => w.length > 0).length
    upsertTranscriptStage1({
      recording_id: recordingId,
      full_text: fullText,
      language: asrResult.language,
      word_count: stage1WordCount,
      transcription_provider: config.transcription.provider,
      transcription_model:
        config.transcription.provider === 'openai-whisper'
          ? config.transcription.whisperModel
          : config.transcription.geminiModel
    })

    // Genuine Stage-1-completed-this-run signal (spec §7.2): emitted ONLY after
    // the Stage-1 ASR write succeeds, so the wrapper clears parking here — never
    // on the Stage-2-only resume's 'analyzing' (which fires before the LLM call
    // and completes nothing this run). The wrapper normalizes this internal label
    // back to 'analyzing'/50 for the renderer (its progress contract is unchanged).
    progressCallback?.('stage1_complete', 50) // spec-014/P4: Stage-1 done -> clear parking
  }

  // ===== Stage 2: Analysis =====
  // Stage-2 key check: getLlmProvider throws the canonical key-missing string.
  const llm = getLlmProvider(config)

  // Build meeting selection prompt if there are multiple candidates
  let meetingSelectionSection = ''
  if (candidateMeetings.length > 1) {
    meetingSelectionSection = `
5. IMPORTANT - Meeting Selection: Based on the transcript content, determine which meeting this recording most likely belongs to.
   Analyze mentions of topics, people, projects, or context clues to select the best match.

   Available meetings:
${candidateMeetings.map((m, i) => `   ${i + 1}. "${m.subject}" (ID: ${m.id})`).join('\n')}

   Include in your response:
   "selected_meeting_id": "the meeting ID that best matches",
   "meeting_confidence": 0.0 to 1.0 (how confident you are),
   "selection_reason": "why you selected this meeting"`
  } else if (candidateMeetings.length === 1) {
    meetingSelectionSection = `
5. Meeting Selection: There is one candidate meeting near this recording's time:
   1. "${candidateMeetings[0].subject}" (ID: ${candidateMeetings[0].id})

   Determine if this recording actually belongs to this meeting based on topics, people, and context.
   If the content does NOT match the meeting subject, set meeting_confidence to 0.0 and selected_meeting_id to "none".

   "selected_meeting_id": "the meeting ID if it matches, or \\"none\\" if it doesn't",
   "meeting_confidence": 0.0 to 1.0,
   "selection_reason": "why you selected or rejected this meeting"`
  }

  // D5 §6.6: Stage 2 summarizes a SPEAKER-LABELED transcript when structured turns
  // exist — each turn prefixed with the mapped contact name if available, else
  // "Speaker <label>". Falls back to flat full_text for Whisper/Gemini / pre-
  // migration / zero-speaker rows. The LLM call + JSON parse are unchanged.
  const analysisInput = buildAttributedTranscript(recordingId) ?? fullText

  // Now analyze the transcription for summary, action items, etc.
  const analysisPrompt = `Analyze this meeting transcript and provide:
1. A brief summary (2-3 sentences)
2. A list of action items mentioned (as a JSON array of strings)
3. Key topics discussed (as a JSON array of strings)
4. Key points or decisions made (as a JSON array of strings)
5. A short, descriptive title for this recording (3-8 words that capture the essence)
6. 4-5 specific, context-aware questions that could be asked about this recording
   - Questions should be SPECIFIC to the content (e.g., "What was decided about the Q3 marketing budget?")
   - Avoid generic questions (e.g., "What was discussed?" or "Tell me more")
   - Questions should help users quickly understand key decisions, action items, and outcomes

IMPORTANT: Respond in the SAME LANGUAGE as the transcript. If the transcript is in Spanish, write the summary, action items, topics, key points, title, and questions in Spanish. If English, respond in English.
${meetingSelectionSection}

Transcript:
${analysisInput}

Respond in JSON format:
{
  "summary": "...",
  "action_items": ["...", "..."],
  "topics": ["...", "..."],
  "key_points": ["...", "..."],
  "title_suggestion": "Brief Descriptive Title (3-8 words)",
  "question_suggestions": ["Specific question about decision 1?", "Specific question about action item 2?", "..."],
  "language": "es" or "en"${candidateMeetings.length > 0 ? `,
  "selected_meeting_id": "...",
  "meeting_confidence": 0.0,
  "selection_reason": "..."` : ''}
}`

  const analysisText = await llm.generate(analysisPrompt, { json: true })

  // Parse the analysis JSON.
  // Extraction failure (spec §5.3): BOTH the regex no-match path and the
  // JSON.parse error path THROW (intentionally changing today's swallow-and-
  // complete behavior). The queue retries Stage 2; the marker stays NULL and any
  // pre-existing summary is untouched. No sentinel strings are ever written.
  let analysis: {
    summary?: string
    action_items?: string[]
    topics?: string[]
    key_points?: string[]
    title_suggestion?: string
    question_suggestions?: string[]
    language?: string
    selected_meeting_id?: string
    meeting_confidence?: number
    selection_reason?: string
  }

  const jsonMatch = analysisText.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    throw new Error(
      `Analysis JSON extraction failed: no JSON object in response (${analysisText.slice(0, 120)})`
    )
  }
  try {
    analysis = JSON.parse(jsonMatch[0])
  } catch (e) {
    throw new Error(
      `Analysis JSON extraction failed: ${e instanceof Error ? e.message : 'parse error'}`
    )
  }

  // Meeting-selection validator (spec §5.2): provider-agnostic guard — smaller
  // models return 'none', hallucinated ids, or string confidences far more often
  // than Gemini. Applied BEFORE the candidates loop AND the indexing fallback.
  const candidateIds = new Set(candidateMeetings.map((m) => m.id))
  if (analysis.selected_meeting_id === 'none' || (analysis.selected_meeting_id && !candidateIds.has(analysis.selected_meeting_id))) {
    analysis.selected_meeting_id = undefined
  }
  if (analysis.meeting_confidence !== undefined) {
    const n = Number(analysis.meeting_confidence)
    analysis.meeting_confidence = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0
  }

  // Process AI meeting selection
  if (candidateMeetings.length > 0) {
    // Add all candidates to the database
    for (const meeting of candidateMeetings) {
      const isSelected = analysis.selected_meeting_id === meeting.id
      const confidence = isSelected ? (analysis.meeting_confidence || 0.5) : 0.1
      const reason = isSelected ? (analysis.selection_reason || 'Time overlap') : 'Time overlap only'

      addRecordingMeetingCandidate(recordingId, meeting.id, confidence, reason, isSelected)
    }

    // If AI selected a meeting with sufficient confidence, link it
    const MIN_LINK_CONFIDENCE = 0.4
    if (analysis.selected_meeting_id && analysis.selected_meeting_id !== 'none') {
      const selectedMeeting = candidateMeetings.find(m => m.id === analysis.selected_meeting_id)
      const confidence = analysis.meeting_confidence || 0
      if (selectedMeeting && confidence >= MIN_LINK_CONFIDENCE) {
        linkRecordingToMeeting(
          recordingId,
          selectedMeeting.id,
          confidence,
          'ai_transcript_match'
        )
        console.log(`AI matched recording to meeting: "${selectedMeeting.subject}" (confidence: ${confidence})`)
      } else if (selectedMeeting && confidence < MIN_LINK_CONFIDENCE) {
        console.log(`AI match rejected (low confidence ${confidence}): "${selectedMeeting.subject}"`)
      }
    }
  }

  // Auto-rename predicate (spec §5.3): pre-read the current title_suggestion
  // BEFORE the Stage-2 write. Auto-rename runs iff it was NULL (first time a
  // title is written) — a resummarize on a row that already has a title never
  // renames, and a retried first run still renames (it left NULL on failure).
  const preUpdate = getTranscriptByRecordingId(recordingId)
  const isFirstTitle = !preUpdate?.title_suggestion

  // Stage-2 write: the single atomic marker write (spec §5.3).
  updateTranscriptStage2(recordingId, {
    summary: analysis.summary,
    action_items: analysis.action_items ? JSON.stringify(analysis.action_items) : undefined,
    topics: analysis.topics ? JSON.stringify(analysis.topics) : undefined,
    key_points: analysis.key_points ? JSON.stringify(analysis.key_points) : undefined,
    title_suggestion: analysis.title_suggestion,
    question_suggestions: analysis.question_suggestions
      ? JSON.stringify(analysis.question_suggestions)
      : undefined,
    language: analysis.language || 'unknown',
    summarization_provider: config.summarization.provider,
    summarization_model:
      config.summarization.provider === 'ollama-cloud'
        ? config.summarization.ollamaCloudModel
        : config.transcription.geminiModel // gemini summarization reuses the transcription model (spec §5.2)
  })
  // AI-13: Use standard enum value 'complete' (not 'transcribed').
  // Same point as today (immediately after the Stage-2 UPDATE, before the tail).
  updateRecordingTranscriptionStatus(recordingId, 'complete')

  // Auto-update recording title only on the first title write.
  if (analysis.title_suggestion && isFirstTitle) {
    updateKnowledgeCaptureTitle(recordingId, analysis.title_suggestion)
  }

  progressCallback?.('detecting_actionables', 75) // spec-014: progress reporting

  // Detect actionables from transcript
  try {
    const knowledgeCapture = queryOne<{ id: string }>(
      'SELECT id FROM knowledge_captures WHERE source_recording_id = ?',
      [recordingId]
    )
    const sourceKnowledgeId = knowledgeCapture?.id || recordingId

    const detections = await detectActionables(llm, fullText, sourceKnowledgeId, {
      title: analysis.title_suggestion,
      questions: analysis.question_suggestions
    })

    // Delete-and-replace for PENDING rows only (spec §5.3, refined), gated on a
    // COMPLETED detection run (non-null): clearing duplicates prevents the
    // historical re-run append-duplication while leaving user-actioned
    // (in_progress/generated/shared/dismissed) actionables intact. A null
    // return = the detection LLM call FAILED — skip the whole block so a
    // transient failure never wipes pending cards with nothing to replace them.
    if (detections !== null) {
      run(
        "DELETE FROM actionables WHERE source_knowledge_id = ? AND status = 'pending'",
        [sourceKnowledgeId]
      )

      // Create actionable entries with TEXT IDs
      const VALID_TEMPLATE_IDS = ['meeting_minutes', 'interview_feedback', 'project_status', 'action_items']

      for (const detection of detections) {
        const actionableId = `act_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

        // Sanitize template ID: fall back to 'meeting_minutes' if AI suggests an invalid one
        const sanitizedTemplate = detection.suggestedTemplate && VALID_TEMPLATE_IDS.includes(detection.suggestedTemplate)
          ? detection.suggestedTemplate
          : 'meeting_minutes'

        run(
          `INSERT INTO actionables (
            id, source_knowledge_id, type, title, description, status,
            confidence, suggested_template, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            actionableId,
            sourceKnowledgeId, // source_knowledge_id references knowledge_captures.id
            detection.type,
            detection.suggestedTitle,
            detection.reason,
            'pending',
            detection.confidence,
            sanitizedTemplate,
            new Date().toISOString()
          ]
        )
      }

      if (detections.length > 0) {
        console.log(`[Actionable Detection] Created ${detections.length} actionables for ${recordingId}`)
      }
    }
  } catch (error) {
    console.error('[Actionable Detection] Failed to create actionables:', error)
    // Don't fail the transcription if actionable detection fails
  }

  progressCallback?.('indexing', 85) // spec-014: progress reporting

  // Index transcript into vector store for RAG
  try {
    const vectorStore = getVectorStore()
    // Use the AI-linked meeting ID if available, otherwise fall back to the original
    const meetingId = analysis.selected_meeting_id || recording.meeting_id
    let meetingSubject: string | undefined

    if (meetingId) {
      const meeting = getMeetingById(meetingId)
      meetingSubject = meeting?.subject
    }

    const indexedCount = await vectorStore.indexTranscript(fullText, {
      meetingId: meetingId || undefined,
      recordingId,
      timestamp: recording.created_at,
      subject: meetingSubject
    })

    console.log(`Indexed ${indexedCount} chunks into vector store`)
  } catch (e) {
    console.warn('Failed to index transcript into vector store:', e)
  }

  progressCallback?.('complete', 100) // spec-014: progress reporting
  console.log(`Transcription complete: ${recording.filename}`)
}

export async function transcribeManually(recordingId: string): Promise<void> {
  try {
    notifyRenderer('transcription:started', { recordingId })
    await transcribeRecording(recordingId)
    notifyRenderer('transcription:completed', { recordingId })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    notifyRenderer('transcription:failed', { recordingId, error: errorMessage })
    throw error
  }
}

export function getTranscriptionStatus(): {
  isProcessing: boolean
  pendingCount: number
  processingCount: number
} {
  const pending = getQueueItems('pending')
  const processing = getQueueItems('processing')

  return {
    isProcessing,
    pendingCount: pending.length,
    processingCount: processing.length
  }
}

function notifyRenderer(channel: string, data: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data)
  }
}
