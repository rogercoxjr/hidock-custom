/**
 * SourceReader Component
 *
 * Displays the selected recording in the center panel with:
 * - Audio playback controls
 * - Transcript viewer with timestamps
 * - Metadata display (editable when knowledgeCaptureId is present)
 *
 * Shows a placeholder message when no recording is selected.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { TranscriptViewer } from './TranscriptViewer'
import { SpeakersPanel } from './SpeakersPanel'
import type { SuggestionView } from './SpeakersPanel'
import type { Turn } from '../types/turns'
import { AudioPlayer } from '@/components/AudioPlayer'
import { UnifiedRecording, hasLocalPath, isDeviceOnly } from '@/types/unified-recording'
import { Transcript, Meeting, parseJsonArray } from '@/types'
import { Calendar, Download, Trash2, Wand2, RefreshCw, Play, Square, Pencil, Check, Edit2, Link, X, AlertCircle, ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem
} from '@/components/ui/select'
import { toast } from '@/components/ui/toaster'
import { RecordingLinkDialog } from '@/components/RecordingLinkDialog'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { useConfigStore } from '@/store/domain/useConfigStore'
import { labelName } from '@/features/library/utils'
import type { LabelDefinition } from '@/types'
import { formatDateTime, formatDuration, formatBytes } from '@/lib/utils'
import { TemplateChip, SuggestNewBanner } from './TemplateChip'
import { Eyebrow } from '@/components/harbor/Eyebrow'
import { Markdown } from '@/components/ui/markdown'

// Stable empty reference so the labels selector never yields a fresh [] per render
// (keeps useCallback deps that reference labelItems stable).
const EMPTY_LABELS: LabelDefinition[] = []

interface SourceReaderProps {
  recording: UnifiedRecording | null
  transcript?: Transcript
  meeting?: Meeting
  isPlaying?: boolean
  currentTimeMs?: number
  onPlay?: () => void
  onStop?: () => void
  onSeek?: (startMs: number, endMs?: number) => void
  // Jump audio to a speaker's first turn (ms) and start playing. Forwarded to
  // SpeakersPanel so a speaker name click seeks+plays; transcript follows via
  // the existing currentTimeMs highlight. Distinct from onSeek (transcript-line
  // scrub) — this one loads+plays when the recording isn't the active audio.
  onJumpToTime?: (startMs: number) => void
  // Action button callbacks
  onDownload?: () => void
  // `force` (D5 §6.8 / AC6) re-queues an already-transcribed recording, bypassing
  // the parent's complete-guard so the server-side marker-clear + mapping-drop runs.
  onTranscribe?: (force?: boolean) => void
  onResummarize?: () => void
  onDelete?: () => void
  // State for button enabling/disabling
  deviceConnected?: boolean
  isDownloading?: boolean
  downloadProgress?: number
  downloadStage?: 'reading' | 'uploading' | 'saving' | null
  isDeleting?: boolean
  // Navigation
  onNavigateToMeeting?: (meetingId: string) => void
  // Metadata editing callback
  onMetadataEdited?: () => void
}

export function SourceReader({
  recording,
  transcript,
  meeting,
  isPlaying = false,
  currentTimeMs = 0,
  onPlay,
  onStop,
  onSeek,
  onJumpToTime,
  onDownload,
  onTranscribe,
  onResummarize,
  onDelete,
  deviceConnected = false,
  isDownloading = false,
  downloadProgress,
  downloadStage,
  isDeleting = false,
  onNavigateToMeeting,
  onMetadataEdited
}: SourceReaderProps) {

  // Summary collapse state (QOL #5 — summary is now at the top of the reader)
  const [summaryExpanded, setSummaryExpanded] = useState(true)

  // Title editing state
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [editedTitle, setEditedTitle] = useState('')
  const [isSavingTitle, setIsSavingTitle] = useState(false)

  // Category saving state
  const [isSavingCategory, setIsSavingCategory] = useState(false)

  // Smart Labels taxonomy — drives the category dropdown options + display names.
  const labelItems = useConfigStore((s) => s.config?.labels?.items) ?? EMPTY_LABELS

  // Meeting link dialog state
  const [linkDialogOpen, setLinkDialogOpen] = useState(false)

  // Transcription warning state
  const [metadataEdited, setMetadataEdited] = useState(false)
  const [showTranscribeWarning, setShowTranscribeWarning] = useState(false)

  // D5 §6.6: "summary uses generic speaker labels" staleness badge.
  const [summaryStale, setSummaryStale] = useState(false)

  // D5 §6.8: re-transcribe confirmation for an already-transcribed recording.
  const [showRetranscribeConfirm, setShowRetranscribeConfirm] = useState(false)

  // Speaker diarization (D3-T4): structured turns + speaker->contact name map.
  // SourceReader is the LIVE host of the diarization UI. Turns come from
  // transcript.turns (JSON); names from speakers:getForRecording.
  const recordingId = recording?.id
  const [turns, setTurns] = useState<Turn[]>([])
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({})
  const [speakerAssignments, setSpeakerAssignments] = useState<
    Record<string, { contactId: string; contactName: string }>
  >({})

  // Phase 2B: pending matcher suggestions + loading state + re-transcribe banner.
  const [suggestions, setSuggestions] = useState<SuggestionView[]>([])
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(false)
  const [showSuggestionsBanner, setShowSuggestionsBanner] = useState(false)
  const hadAssignmentsRef = useRef(false)
  // Monotonic token so only the latest refreshSpeakers run may write state.
  const refreshTokenRef = useRef(0)

  // Phase 3 (Task 13b): template provenance state — must be declared BEFORE the
  // recording-change reset effect so setLatestRunView is in scope.
  const [latestRunView, setLatestRunView] = useState<{
    confidence: number | null
    kind: string | null
    suggestedTemplate: Record<string, unknown> | null
    instructionsChanged: boolean
  } | null>(null)

  // Phase 4 (Task 13): "Re-summarize with…" dropdown state.
  const [userTemplates, setUserTemplates] = useState<Array<{ id: string; name: string }>>([])
  const [isResummarizingWithTemplate, setIsResummarizingWithTemplate] = useState(false)

  // Reset all state when recording changes. Speaker/suggestion state is reset HERE
  // (keyed on recording id) and NOT on transcript changes — otherwise the batched
  // transcript fetch flipping the `transcript` prop undefined->object would blank
  // freshly-loaded suggestions (the "suggestions flash then vanish" bug).
  useEffect(() => {
    setIsEditingTitle(false)
    setEditedTitle('')
    setLinkDialogOpen(false)
    setMetadataEdited(false)
    setShowTranscribeWarning(false)
    hadAssignmentsRef.current = false
    setSpeakerNames({})
    setSpeakerAssignments({})
    setSuggestions([])
    setShowSuggestionsBanner(false)
    setLatestRunView(null)
  }, [recording?.id])

  // D5 §6.6: probe staleness whenever the recording or transcript changes. The
  // badge appears once a speaker mapping post-dates the summary and clears after
  // a successful resummarize (parent refreshes `transcript`, this re-runs).
  useEffect(() => {
    let cancelled = false
    if (!recording || !transcript?.full_text) {
      setSummaryStale(false)
      return
    }
    window.electronAPI?.recordings
      ?.isSummaryStale?.(recording.id)
      ?.then((stale) => { if (!cancelled) setSummaryStale(stale) })
      ?.catch(() => { if (!cancelled) setSummaryStale(false) })
    return () => { cancelled = true }
  }, [recording, transcript])

  // Phase 3 (Task 13b): fetch template provenance (confidence + kind + instructionsChanged)
  // from the latestRun IPC whenever the recording or transcript changes.
  useEffect(() => {
    let cancelled = false
    if (!recording || !transcript?.full_text) {
      setLatestRunView(null)
      return
    }
    window.electronAPI?.summarizationTemplates
      ?.latestRun?.(recording.id)
      ?.then((res) => {
        if (cancelled) return
        if (res?.success && res.data) {
          setLatestRunView({
            confidence: res.data.confidence,
            kind: res.data.kind,
            suggestedTemplate: res.data.suggestedTemplate,
            instructionsChanged: res.data.instructionsChanged,
          })
        } else {
          setLatestRunView(null)
        }
      })
      ?.catch(() => { if (!cancelled) setLatestRunView(null) })
    return () => { cancelled = true }
  }, [recording, transcript])

  // Phase 4 (Task 13): load the enabled user templates for the "Re-summarize with…"
  // dropdown whenever the component mounts (templates are stable across recordings).
  // Only non-builtin enabled templates are shown (user-defined ones).
  useEffect(() => {
    let cancelled = false
    window.electronAPI?.summarizationTemplates
      ?.list?.()
      ?.then((res) => {
        if (cancelled) return
        if (res?.success && Array.isArray(res.data)) {
          setUserTemplates(
            res.data
              .filter((t: { enabled: boolean; isBuiltin: boolean }) => t.enabled && !t.isBuiltin)
              .map((t: { id: string; name: string }) => ({ id: t.id, name: t.name }))
          )
        }
      })
      ?.catch(() => { if (!cancelled) setUserTemplates([]) })
    return () => { cancelled = true }
  }, [])

  /**
   * Re-fetch the recording's turns (transcripts:getByRecordingId), its
   * speaker->contact-name map (speakers:getForRecording), and pending matcher
   * suggestions (speakers:getSuggestions). Called on recording change and again
   * whenever the SpeakersPanel reports an edit, so the panel reflects new turns,
   * names, and suggestions live.
   */
  const refreshSpeakers = useCallback(async () => {
    if (!recordingId) {
      setTurns([])
      setSpeakerNames({})
      setSuggestions([])
      setShowSuggestionsBanner(false)
      return
    }
    // Defensive: a partially-initialized electronAPI (e.g. in unit tests) or a
    // missing IPC must NOT produce an unhandled rejection on mount. No-op if absent.
    const api = window.electronAPI
    if (!api?.transcripts?.getByRecordingId || !api?.speakers?.getForRecording) return

    // Claim the latest token; any run that finds it superseded after an await
    // bails without writing (guards against stale/overlapping refreshes — e.g. a
    // previous recording's in-flight fetch, or the pre-transcript-populate run).
    const token = ++refreshTokenRef.current
    setIsLoadingSuggestions(!!api?.speakers?.getSuggestions)
    try {
      const [freshTranscript, speakerRes] = await Promise.all([
        api.transcripts.getByRecordingId(recordingId),
        api.speakers.getForRecording(recordingId),
      ])
      if (refreshTokenRef.current !== token) return

      let parsedTurns: Turn[] = []
      const rawTurns = (freshTranscript as Transcript | null | undefined)?.turns
      if (rawTurns) {
        try { parsedTurns = JSON.parse(rawTurns) } catch { parsedTurns = [] }
      }
      setTurns(parsedTurns)

      const names: Record<string, string> = {}
      const assignments: Record<string, { contactId: string; contactName: string }> = {}
      if (speakerRes?.success && speakerRes.data) {
        for (const [label, entry] of Object.entries(speakerRes.data)) {
          const e = entry as { contactId: string; contactName: string }
          names[label] = e.contactName
          assignments[label] = { contactId: e.contactId, contactName: e.contactName }
        }
      }
      setSpeakerNames(names)
      setSpeakerAssignments(assignments)

      if (Object.keys(assignments).length > 0) {
        hadAssignmentsRef.current = true
      }

      if (api?.speakers?.getSuggestions) {
        const sugRes = await api.speakers.getSuggestions(recordingId)
        if (refreshTokenRef.current !== token) return
        const next = sugRes?.success && Array.isArray(sugRes.data) ? sugRes.data : []
        setSuggestions(next)
        setShowSuggestionsBanner(
          next.length > 0 && hadAssignmentsRef.current && Object.keys(assignments).length === 0
        )
      }
    } catch {
      // Swallow IPC/parse failures: the prop-seeded turns remain; never propagate.
    } finally {
      if (refreshTokenRef.current === token) setIsLoadingSuggestions(false)
    }
  }, [recordingId])

  // Compute whether a new speaker letter can still be minted (Z not in use). Mirrors the
  // handler's nextUnusedLetter Z-guard so the picker disables "New speaker" when full.
  //
  // INTENTIONAL ASYMMETRY — do NOT "unify" this with nextUnusedLetter. The renderer only needs
  // "is Z already in use?" (spec §4.6: if Z is in use, New speaker is disabled). The handler runs
  // the full nextUnusedLetter over the union of turn labels + recording_speakers rows and may
  // return null for the same condition. A recording whose ONLY label is 'Z' correctly disables
  // New speaker in BOTH paths (renderer: Z present → false; handler: highest === Z → null).
  // nextUnusedLetter is a node-main export; importing it into this renderer would cross the
  // web/node program boundary and break typecheck — keep this simple local check.
  const canMintNewSpeaker = !turns.some((t) => (t.speaker ?? '').trim().toUpperCase() === 'Z')

  const handleReassign = useCallback(
    async (request: {
      sourceLabel: string
      anchorIndex: number
      anchorStartMs: number
      scope: 'one' | 'before' | 'after'
      target: { kind: 'existingLabel'; label: string } | { kind: 'contact'; contactId: string } | { kind: 'newSpeaker' }
    }) => {
      if (!recordingId) return
      try {
        const res = await window.electronAPI.speakers.reassignTurns({ recordingId, ...request })
        if (res?.success) {
          refreshSpeakers().catch(() => {})
        } else {
          toast.error('Could not reassign turn', res?.error?.message)
        }
      } catch (err) {
        toast.error('Could not reassign turn', err instanceof Error ? err.message : String(err))
      }
    },
    [recordingId, refreshSpeakers]
  )

  // Seed turns from the prop transcript immediately (so the panel renders before the
  // async fetch resolves), then fetch fresh turns + assignment names + suggestions.
  const transcriptTurns = transcript?.turns
  useEffect(() => {
    // Seed turns from the prop so the panel renders before the async fetch resolves,
    // then refresh. Do NOT blank speakerNames/suggestions here — that reset is keyed
    // on recording id above; blanking on every transcript change caused suggestions to
    // flash then vanish when the parent's batched transcript fetch populated the prop.
    let parsed: Turn[] = []
    if (transcriptTurns) {
      try { parsed = JSON.parse(transcriptTurns) } catch { parsed = [] }
    }
    setTurns(parsed)
    refreshSpeakers().catch(() => {})
  }, [recordingId, transcriptTurns, refreshSpeakers])

  const hasStructuredTurns = turns.length > 0

  const handleSaveTitle = useCallback(async () => {
    if (!recording?.knowledgeCaptureId) return
    const trimmed = editedTitle.trim()
    if (!trimmed) {
      setEditedTitle(recording.title || recording.filename)
      toast.error('Title cannot be empty')
      return
    }
    if (trimmed === (recording.title || recording.filename)) {
      setIsEditingTitle(false)
      return
    }
    setIsSavingTitle(true)
    try {
      const result = await window.electronAPI.knowledge.update(
        recording.knowledgeCaptureId,
        { title: trimmed }
      )
      if (result.success) {
        setIsEditingTitle(false)
        setMetadataEdited(true)
        toast.success('Title updated')
        onMetadataEdited?.()
      } else {
        toast.error('Failed to save title')
      }
    } catch (err) {
      console.error('Failed to save title:', err)
      toast.error('Failed to save title')
    } finally {
      setIsSavingTitle(false)
    }
  }, [editedTitle, recording, onMetadataEdited])

  const handleCancelTitle = useCallback(() => {
    setIsEditingTitle(false)
    setEditedTitle('')
  }, [])

  const handleCategoryChange = useCallback(async (newCategory: string) => {
    if (!recording?.knowledgeCaptureId) return
    if (newCategory === recording.category) return
    // App-layer validation (replaces the dropped DB CHECK): only persist a category
    // that exists in the taxonomy.
    if (!labelItems.some((l) => l.id === newCategory)) {
      toast.error('Unknown label')
      return
    }
    setIsSavingCategory(true)
    try {
      const result = await window.electronAPI.knowledge.update(
        recording.knowledgeCaptureId,
        { category: newCategory }
      )
      if (result.success) {
        setMetadataEdited(true)
        toast.success('Category updated')
        onMetadataEdited?.()
      } else {
        toast.error('Failed to save category')
      }
    } catch (err) {
      console.error('Failed to save category:', err)
      toast.error('Failed to save category')
    } finally {
      setIsSavingCategory(false)
    }
  }, [recording, onMetadataEdited, labelItems])

  const handleRemoveMeetingLink = useCallback(async () => {
    if (!recording) return
    try {
      await window.electronAPI.recordings.selectMeeting(recording.id, null)
      setMetadataEdited(true)
      onMetadataEdited?.()
    } catch (err) {
      console.error('Failed to remove meeting link:', err)
      toast.error('Failed to remove meeting link')
    }
  }, [recording, onMetadataEdited])

  const handleTranscribeClick = useCallback(() => {
    if (metadataEdited) {
      setShowTranscribeWarning(true)
    } else {
      // First-time transcribe (button only renders when there's no full_text) — not forced.
      onTranscribe?.(false)
    }
  }, [metadataEdited, onTranscribe])

  if (!recording) {
    return (
      <div className="flex h-full items-center justify-center bg-bg text-ink-muted">
        <div className="space-y-2 text-center">
          <p className="font-display text-[1.375rem] font-semibold tracking-[-0.01em] text-ink">No recording selected</p>
          <p className="text-sm">Select a recording from the list to view details</p>
        </div>
      </div>
    )
  }

  const canPlay = hasLocalPath(recording)

  const linkDialogRecording = {
    id: recording.id,
    filename: recording.filename,
    date_recorded: recording.dateRecorded instanceof Date
      ? recording.dateRecorded.toISOString()
      : String(recording.dateRecorded),
    duration_seconds: recording.duration ?? null
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg">
      {/* Header with comprehensive metadata */}
      <div className="space-y-4 border-b border-border bg-surface p-[var(--space-5)]">
        <div>
          <div className="mb-4">
            {isEditingTitle ? (
              <div className="flex items-center gap-2">
                <Input
                  value={editedTitle}
                  onChange={(e) => setEditedTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveTitle()
                    if (e.key === 'Escape') handleCancelTitle()
                  }}
                  className="h-auto py-1 font-display text-[1.75rem] font-semibold tracking-[-0.02em]"
                  autoFocus
                  disabled={isSavingTitle}
                  aria-label="Recording title"
                />
                <Button variant="ghost" size="sm" onClick={handleSaveTitle} disabled={isSavingTitle} aria-label="Save title" title="Save (Enter)">
                  <Check className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="sm" onClick={handleCancelTitle} disabled={isSavingTitle} aria-label="Cancel editing" title="Cancel (Escape)">
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <div className="group flex items-center gap-2">
                <h2
                  className="line-clamp-2 font-display text-[1.75rem] font-semibold leading-[1.1] tracking-[-0.02em] text-ink"
                  title={recording.title || meeting?.subject || recording.filename}
                >
                  {recording.title || meeting?.subject || recording.filename}
                </h2>
                {recording.knowledgeCaptureId && (
                  <button
                    onClick={() => {
                      setIsEditingTitle(true)
                      setEditedTitle(recording.title || recording.filename)
                    }}
                    className="rounded-sm p-1 opacity-0 transition-opacity hover:bg-surface-hover group-hover:opacity-100"
                    aria-label="Edit title"
                    title="Edit title"
                  >
                    <Pencil className="h-4 w-4 text-ink-muted" />
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Comprehensive Metadata Grid */}
          <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-3 lg:grid-cols-4">
            <div>
              <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-muted">Date Recorded</p>
              <p className="text-foreground">{(() => {
                const date = new Date(recording.dateRecorded)
                return !isNaN(date.getTime()) ? formatDateTime(date.toISOString()) : 'Unknown'
              })()}</p>
            </div>
            <div>
              <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-muted">Duration</p>
              <p className="text-foreground">{recording.duration ? formatDuration(recording.duration) : 'Unknown'}</p>
            </div>
            <div>
              <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-muted">Size</p>
              <p className="text-foreground">{recording.size ? formatBytes(recording.size) : 'Unknown'}</p>
            </div>
            <div>
              <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-muted">Quality</p>
              <p className="capitalize text-foreground">{recording.quality || 'Standard'}</p>
            </div>
            <div>
              <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-muted">Category</p>
              {recording.knowledgeCaptureId ? (
                <Select
                  value={recording.category || ''}
                  onValueChange={handleCategoryChange}
                  disabled={isSavingCategory}
                >
                  <SelectTrigger className="h-7 w-[140px] text-sm">
                    <SelectValue placeholder="Select category">
                      {labelName(labelItems, recording.category) || undefined}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {labelItems.map((opt) => (
                      <SelectItem key={opt.id} value={opt.id}>
                        {opt.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                // S4: no capture row to write to (device-only / untranscribed) — show a
                // disabled control with a tooltip explaining how to unlock labeling.
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span tabIndex={0} className="inline-block">
                        <Select value="" disabled>
                          <SelectTrigger
                            className="h-7 w-[140px] text-sm"
                            aria-label="Category (transcribe to enable)"
                          >
                            <SelectValue placeholder="Not labeled" />
                          </SelectTrigger>
                        </Select>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>Transcribe to label this recording</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>
            <div>
              <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-muted">Location</p>
              <p className="capitalize text-foreground">{recording.location.replace('-', ' ')}</p>
            </div>
            <div>
              <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-muted">Transcription</p>
              <p className="capitalize text-foreground">{recording.transcriptionStatus}</p>
            </div>
            <div>
              <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-muted">Filename</p>
              <p className="truncate text-foreground" title={recording.filename}>{recording.filename}</p>
            </div>
          </div>

          {/* Linked Meeting */}
          {meeting && (
            <div className="mt-4 flex items-center gap-2 rounded-lg border border-border bg-surface-sunken p-3">
              <div
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 transition-opacity hover:opacity-80"
                onClick={() => onNavigateToMeeting?.(meeting.id)}
              >
                <Calendar className="h-4 w-4 shrink-0 text-accent-2" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">{meeting.subject}</p>
                  <p className="font-mono text-[11px] text-ink-muted">{formatDateTime(meeting.start_time)}</p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                onClick={(e) => { e.stopPropagation(); setLinkDialogOpen(true) }}
                title="Change linked meeting"
              >
                <Edit2 className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 text-ink-muted hover:text-destructive"
                onClick={(e) => { e.stopPropagation(); handleRemoveMeetingLink() }}
                title="Remove meeting link"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}

          {/* Device-only notice */}
          {isDeviceOnly(recording) && (
            <p className="mt-3 text-xs italic text-ink-muted">
              Download this capture to play it and generate a transcript.
            </p>
          )}
        </div>
      </div>

      {/* Action Buttons Section */}
      <div className="flex flex-wrap gap-2 border-b border-border bg-surface-sunken px-[var(--space-5)] py-3">
        {/* Play/Stop Button - only for local recordings - LB-03 fix: Wire up onPlay callback */}
        {canPlay && onPlay && (
          isPlaying ? (
            <Button
              variant="outline"
              size="sm"
              onClick={onStop}
              className="gap-2"
              title="Stop playback"
            >
              <Square className="h-4 w-4" />
              Stop
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={onPlay}
              className="gap-2"
              title="Play recording"
            >
              <Play className="h-4 w-4" />
              Play
            </Button>
          )
        )}

        {/* storage.openFile / revealInFolder — DROPPED in hosted mode (no server filesystem access) */}

        {!meeting && !isDeviceOnly(recording) && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setLinkDialogOpen(true)}
            className="gap-2"
            title="Link this recording to a meeting"
          >
            <Link className="h-4 w-4" />
            Link Meeting
          </Button>
        )}

        {/* Download Button - only for device-only recordings */}
        {isDeviceOnly(recording) && onDownload && (
          <Button
            variant="outline"
            size="sm"
            onClick={onDownload}
            disabled={!deviceConnected || isDownloading}
            className="gap-2"
            title={!deviceConnected ? "Device not connected" : "Download recording from device"}
          >
            {isDownloading ? (
              <>
                <RefreshCw className="h-4 w-4 animate-spin" />
                {downloadStage ? { reading: 'Reading', uploading: 'Uploading', saving: 'Saving' }[downloadStage] + ' ' : ''}
                {downloadProgress !== undefined ? `${downloadProgress}%` : 'Downloading...'}
              </>
            ) : (
              <>
                <Download className="h-4 w-4" />
                Download
              </>
            )}
          </Button>
        )}

        {/* Transcribe Button - first-time only: local recording with NO transcript yet.
            Mutually exclusive with Re-transcribe (which owns the has-full_text case),
            so the two never render together when full_text exists but status !== 'complete'. */}
        {hasLocalPath(recording) && recording.transcriptionStatus !== 'complete' && !transcript?.full_text && onTranscribe && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleTranscribeClick}
            disabled={recording.transcriptionStatus === 'pending' || recording.transcriptionStatus === 'processing'}
            className="gap-2"
            title={
              recording.transcriptionStatus === 'pending' ? "Transcription queued" :
              recording.transcriptionStatus === 'processing' ? "Transcription in progress" :
              "Start AI transcription"
            }
          >
            {recording.transcriptionStatus === 'processing' ? (
              <>
                <RefreshCw className="h-4 w-4 animate-spin" />
                In Progress
              </>
            ) : recording.transcriptionStatus === 'pending' ? (
              <>
                <RefreshCw className="h-4 w-4" />
                Queued
              </>
            ) : (
              <>
                <Wand2 className="h-4 w-4" />
                Transcribe
              </>
            )}
          </Button>
        )}

        {/* Transcript export — JSON always; CSV/SRT only when the transcript is diarized. */}
        {transcript?.full_text && recordingId && (
          <Select
            onValueChange={async (format) => {
              try {
                const response = await fetch(
                  `/api/recordings/${recordingId}/transcript/export?format=${encodeURIComponent(format)}`,
                  { method: 'POST', credentials: 'include' }
                )
                if (!response.ok) {
                  const body = await response.json().catch(() => ({}))
                  toast.error('Export failed', body.error || `HTTP ${response.status}`)
                  return
                }
                const blob = await response.blob()
                const ext = format === 'json' ? 'json' : format === 'csv' ? 'csv' : 'srt'
                const filename = `transcript-${recordingId}.${ext}`
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = filename
                a.click()
                URL.revokeObjectURL(url)
                toast.success('Transcript exported', `Downloaded as ${filename}`)
              } catch (err) {
                toast.error('Export failed', err instanceof Error ? err.message : String(err))
              }
            }}
          >
            <SelectTrigger
              className="h-8 w-auto gap-1 text-sm"
              title="Export the transcript to a file"
              data-testid="transcript-export-trigger"
            >
              <Download className="h-4 w-4" />
              <SelectValue placeholder="Export…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="json">JSON</SelectItem>
              <SelectItem value="csv" disabled={turns.length === 0}>
                {turns.length === 0 ? 'CSV — Requires diarization' : 'CSV'}
              </SelectItem>
              <SelectItem value="srt" disabled={turns.length === 0}>
                {turns.length === 0 ? 'SRT — Requires diarization' : 'SRT'}
              </SelectItem>
            </SelectContent>
          </Select>
        )}

        {/* Re-summarize - any recording with a transcript (spec §5.6: healthy + failed).
            Suppressed when the staleness badge is visible (D5-T3): the badge's
            contextual Re-summarize button is the single affordance in that state. */}
        {transcript?.full_text && onResummarize && !summaryStale && (
          <Button
            variant="outline"
            size="sm"
            onClick={onResummarize}
            disabled={recording.transcriptionStatus === 'pending' || recording.transcriptionStatus === 'processing'}
            className="gap-2"
            title="Regenerate the summary with the currently selected summarization model"
          >
            <RefreshCw className="h-4 w-4" />
            Re-summarize
          </Button>
        )}

        {/* Phase 4 (Task 13): "Re-summarize with…" dropdown — single-shot template override.
            Visible when there is a transcript AND at least one enabled user template exists.
            Calls resummarizeWithTemplate (concurrency-guarded, spec §8.3). */}
        {transcript?.full_text && onResummarize && !summaryStale && userTemplates.length > 0 && (
          <Select
            disabled={
              recording.transcriptionStatus === 'pending' ||
              recording.transcriptionStatus === 'processing' ||
              isResummarizingWithTemplate
            }
            onValueChange={async (templateId) => {
              if (!recording || isResummarizingWithTemplate) return
              setIsResummarizingWithTemplate(true)
              try {
                const res = await window.electronAPI?.summarizationTemplates?.resummarizeWithTemplate?.(
                  recording.id,
                  templateId
                )
                if (!res?.success) {
                  toast.error(
                    'Re-summarize failed',
                    res?.error ?? 'Unknown error'
                  )
                } else {
                  // Trigger parent refresh (same path as plain Re-summarize).
                  onResummarize()
                }
              } catch (err) {
                toast.error('Re-summarize failed', err instanceof Error ? err.message : String(err))
              } finally {
                setIsResummarizingWithTemplate(false)
              }
            }}
          >
            <SelectTrigger
              className="h-8 w-auto gap-1 text-sm"
              title="Re-summarize using a specific template (single-shot override)"
              data-testid="resummarize-with-template-trigger"
            >
              <RefreshCw className={`h-4 w-4 ${isResummarizingWithTemplate ? 'animate-spin' : ''}`} />
              <SelectValue placeholder="with template…" />
            </SelectTrigger>
            <SelectContent>
              {userTemplates.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {/* D5 §6.8: Re-transcribe (re-runs ASR with speaker detection) — only for
            an already-transcribed recording; gated behind a confirm dialog. */}
        {transcript?.full_text && onTranscribe && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowRetranscribeConfirm(true)}
            disabled={recording.transcriptionStatus === 'pending' || recording.transcriptionStatus === 'processing'}
            className="gap-2"
            title="Re-run transcription with speaker detection (replaces the current transcript)"
          >
            <RefreshCw className="h-4 w-4 text-accent-2" />
            Re-transcribe
          </Button>
        )}

        {/* Delete Button - always available */}
        {onDelete && (
          <Button
            variant="outline"
            size="sm"
            onClick={onDelete}
            disabled={(isDeviceOnly(recording) && !deviceConnected) || isDeleting}
            className="gap-2 text-destructive hover:text-destructive"
            title={
              isDeviceOnly(recording) && !deviceConnected ? "Device not connected" :
              isDeleting ? "Deleting..." :
              "Delete recording"
            }
          >
            {isDeleting ? (
              <RefreshCw className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
            Delete
          </Button>
        )}
      </div>

      {/* Audio Player — shown whenever recording has local file */}
      {canPlay && (
        <div className="sticky top-0 z-10 border-b border-border bg-surface px-[var(--space-5)] py-3">
          <AudioPlayer key={recording.id} filename={recording.filename} onClose={onStop} />
        </div>
      )}

      {/* Transcript Content */}
      <div className="flex-1 overflow-auto p-[var(--space-5)]">
        {transcript ? (
          <>
            {summaryStale && (
              <div className="mb-3 flex items-center gap-2 rounded-md border border-[color-mix(in_oklch,var(--amber-600)_26%,transparent)] bg-warning-soft px-3 py-2 text-sm text-foreground">
                <AlertCircle className="h-4 w-4 text-warning" />
                <span>Summary uses generic speaker labels — re-summarize to attribute names.</span>
                {onResummarize && (
                  <Button variant="link" size="sm" className="h-auto p-0" onClick={onResummarize}>
                    Re-summarize
                  </Button>
                )}
              </div>
            )}
            {recording.transcriptionStatus === 'error' && (
              <div className="mb-3 flex items-center gap-2 rounded-md border border-[color-mix(in_oklch,var(--amber-600)_26%,transparent)] bg-warning-soft px-3 py-2 text-sm text-foreground">
                <AlertCircle className="h-4 w-4 text-warning" />
                <span>Summary failed — the transcript is intact.</span>
                {onResummarize && (
                  <Button variant="link" size="sm" className="h-auto p-0" onClick={onResummarize}>
                    Re-summarize
                  </Button>
                )}
              </div>
            )}
            {/* Phase 2B re-transcribe banner: speakers were re-lettered, confirm suggestions. */}
            {showSuggestionsBanner && (
              <div className="mb-3 flex items-center gap-2 rounded-md border border-[color-mix(in_oklch,var(--accent-2)_22%,transparent)] bg-accent-2-soft px-3 py-2 text-sm text-foreground">
                <span>Re-analyzed speakers after re-transcription — confirm the suggestions below.</span>
                <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setShowSuggestionsBanner(false)}>
                  Dismiss
                </Button>
              </div>
            )}
            {/* Phase 3 (Task 13b) / Phase 4 (Task 14): suggest-new banner — spec §10 precedence:
                staleness > error > suggest-new. Only render when no higher-priority
                primary banner is visible. */}
            {!summaryStale && recording.transcriptionStatus !== 'error' && latestRunView?.kind === 'suggest_new' && (
              <SuggestNewBanner
                suggestedTemplate={latestRunView.suggestedTemplate}
                recordingId={recording.id}
                onAccepted={() => {
                  // Clear the suggest-new banner and let the parent refresh the transcript
                  setLatestRunView(null)
                  onResummarize?.()
                }}
              />
            )}
            {isLoadingSuggestions && (
              <div className="mb-3 flex items-center gap-2 text-sm text-ink-muted">
                <RefreshCw className="h-4 w-4 animate-spin text-accent-2" />
                <span>Analyzing voices…</span>
              </div>
            )}

            {/* QOL #5: summary moved to the top of the reader (was inside TranscriptViewer). */}
            {transcript.summary && (
              <div className="mb-4">
                <button
                  onClick={() => setSummaryExpanded(!summaryExpanded)}
                  className="flex w-full items-center justify-between rounded-lg border border-border bg-surface-sunken p-3 transition-colors hover:bg-surface-hover"
                  aria-expanded={summaryExpanded}
                >
                  <Eyebrow tone="muted">Summary</Eyebrow>
                  {summaryExpanded ? (
                    <ChevronDown className="h-4 w-4 text-ink-muted" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-ink-muted" />
                  )}
                </button>
                {summaryExpanded && (
                  <div className="mt-2 rounded-lg border border-border bg-surface p-3 shadow-xs">
                    <Markdown>{transcript.summary}</Markdown>
                  </div>
                )}
              </div>
            )}

            {/* Speakers panel — structured turns only (hidden when no turns) */}
            {hasStructuredTurns && (
              <div className="mb-4">
                <SpeakersPanel
                  recordingId={recording.id}
                  meetingId={meeting?.id}
                  turns={turns}
                  assignedNames={speakerNames}
                  assignedSpeakers={speakerAssignments}
                  suggestions={suggestions}
                  onJumpToTime={onJumpToTime}
                  onChanged={() => { refreshSpeakers().catch(() => {}) }}
                />
              </div>
            )}
            {/* Phase 3 (Task 13b): template chip — renders just before the transcript
                viewer so it appears near the summary header. */}
            {transcript.summarization_template_name && (
              <div className="mb-2">
                <TemplateChip
                  name={transcript.summarization_template_name}
                  confidence={latestRunView?.confidence}
                  instructionsChanged={latestRunView?.instructionsChanged}
                />
              </div>
            )}
            <TranscriptViewer
              transcript={transcript.full_text}
              turns={hasStructuredTurns ? turns : undefined}
              speakerNames={speakerNames}
              meetingId={meeting?.id}
              onReassign={handleReassign}
              canMintNewSpeaker={canMintNewSpeaker}
              currentTimeMs={currentTimeMs}
              onSeek={onSeek || (() => {})}
              showActionItems={true}
              actionItems={parseJsonArray<string>(transcript.action_items)}
            />
          </>
        ) : recording.transcriptionStatus === 'complete' ? (
          <div className="py-8 text-center text-ink-muted">
            <p>Transcript not available</p>
          </div>
        ) : recording.transcriptionStatus === 'pending' || recording.transcriptionStatus === 'processing' ? (
          <div className="py-8 text-center text-ink-muted">
            <p>Transcription in progress...</p>
          </div>
        ) : (
          <div className="py-8 text-center text-ink-muted">
            <p>No transcript available</p>
            {canPlay && (
              <p className="mt-2 text-sm">
                Click &quot;Transcribe&quot; to generate a transcript
              </p>
            )}
          </div>
        )}
      </div>

      {/* Meeting link dialog */}
      <RecordingLinkDialog
        recording={linkDialogOpen ? linkDialogRecording : null}
        meeting={meeting}
        open={linkDialogOpen}
        onClose={() => setLinkDialogOpen(false)}
        onResolved={() => {
          // Note: RecordingLinkDialog calls both onResolved and onClose internally
          // Do NOT call setLinkDialogOpen(false) here to avoid double-close
          setMetadataEdited(true)
          onMetadataEdited?.()
        }}
      />

      {/* Transcription overwrite warning */}
      <ConfirmDialog
        open={showTranscribeWarning}
        onOpenChange={(open) => setShowTranscribeWarning(open)}
        title="Transcription may overwrite your edits"
        description="You've manually edited this recording's metadata. The AI transcription process may overwrite your title, category, and summary changes. Do you want to continue?"
        actionLabel="Continue"
        cancelLabel="Cancel"
        variant="default"
        onConfirm={() => {
          // Metadata-edit warning only fires on the first-time Transcribe button
          // (which renders only without full_text) — so this is never forced.
          onTranscribe?.(false)
          setMetadataEdited(false)
          setShowTranscribeWarning(false)
        }}
      />

      {/* D5 §6.8 / AC6: confirm before re-transcribing — replaces transcript +
          drops speaker mappings (server-side, D5-T4). */}
      <ConfirmDialog
        open={showRetranscribeConfirm}
        onOpenChange={setShowRetranscribeConfirm}
        title="Re-transcribe with speaker detection?"
        description="This replaces the current transcript and its speaker mappings."
        actionLabel="Re-transcribe"
        variant="destructive"
        onConfirm={() => {
          setShowRetranscribeConfirm(false)
          // Forced: bypass the parent's complete-guard so a re-queue actually runs.
          onTranscribe?.(true)
        }}
      />
    </div>
  )
}
