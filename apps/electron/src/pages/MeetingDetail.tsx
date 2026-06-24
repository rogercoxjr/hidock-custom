import { useEffect, useRef, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Clock, MapPin, Users, Mic, FileText, Play, X, Edit, Check, Loader2, Link, Unlink, ChevronDown, ChevronUp, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Eyebrow } from '@/components/harbor/Eyebrow'
import { PersonAvatar } from '@/components/harbor/PersonAvatar'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose
} from '@/components/ui/dialog'
import { formatDateTime, formatDuration } from '@/lib/utils'
import { parseAttendees, parseJsonArray } from '@/types'
import { AudioPlayer } from '@/components/AudioPlayer'
import { MeetingActionables } from '@/components/MeetingActionables'
import { useAudioControls } from '@/components/OperationController'
import { useUIStore } from '@/store/useUIStore'
import { toast } from '@/components/ui/toaster'
import { Markdown } from '@/components/ui/markdown'
import type { MeetingDetails } from '@/types'

const ATTENDEES_COLLAPSED_LIMIT = 8

/**
 * C-MTG-005: Safe date formatting that returns a fallback for invalid dates.
 * Prevents RangeError from Intl.DateTimeFormat when date strings are malformed.
 */
function safeFormatTime(date: Date, options: Intl.DateTimeFormatOptions): string {
  try {
    if (isNaN(date.getTime())) return '--:--'
    return date.toLocaleTimeString('en-US', options)
  } catch {
    return '--:--'
  }
}

function safeFormatDate(date: Date, options: Intl.DateTimeFormatOptions): string {
  try {
    if (isNaN(date.getTime())) return 'Unknown date'
    return date.toLocaleDateString('en-US', options)
  } catch {
    return 'Unknown date'
  }
}

function safeGetTimezoneName(date: Date): string {
  try {
    if (isNaN(date.getTime())) return ''
    return Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
      .formatToParts(date)
      .find(p => p.type === 'timeZoneName')?.value || ''
  } catch {
    return ''
  }
}

export function MeetingDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [details, setDetails] = useState<MeetingDetails | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Edit meeting state (B-MTG-001)
  const [isEditing, setIsEditing] = useState(false)
  const [editForm, setEditForm] = useState({
    subject: '',
    start_time: '',
    end_time: '',
    location: '',
    description: ''
  })

  // Recording link dialog state (B-MTG-002)
  const [linkDialogOpen, setLinkDialogOpen] = useState(false)
  const [linkRecordingId, setLinkRecordingId] = useState<string | null>(null)
  const [availableMeetings, setAvailableMeetings] = useState<any[]>([])
  const [linkLoading, setLinkLoading] = useState(false)

  // Playback loading state (B-MTG-003)
  const [playbackLoading, setPlaybackLoading] = useState<string | null>(null)

  // Actionables error state (AUD2-009)
  const [actionablesError, setActionablesError] = useState<string | null>(null)

  // Attendee overflow state (B-MTG-005)
  const [showAllAttendees, setShowAllAttendees] = useState(false)

  // C-MTG-006: Ref to track playback loading timeout for cleanup on unmount
  const playbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Global playback state
  const currentlyPlayingId = useUIStore((state) => state.currentlyPlayingId)
  const audioControls = useAudioControls()

  // C-MTG-006: Clean up playback timeout on unmount
  useEffect(() => {
    return () => {
      if (playbackTimeoutRef.current) {
        clearTimeout(playbackTimeoutRef.current)
      }
    }
  }, [])

  // B-MTG-004: Memoized loadMeetingDetails
  const loadMeetingDetails = useCallback(async (meetingId: string) => {
    setLoading(true)
    setError(null)
    try {
      const data = await window.electronAPI.meetings.getDetails(meetingId)
      if (!data) {
        throw new Error('Meeting not found')
      }

      // Load actionables separately with error handling (AUD2-009)
      setActionablesError(null)
      try {
        const actionables = await window.electronAPI.actionables.getByMeeting(meetingId)
        data.actionables = actionables
      } catch (actErr) {
        console.error('Failed to load actionables:', actErr)
        data.actionables = []
        setActionablesError('Failed to load actionables')
      }

      setDetails(data)

      // Initialize edit form
      setEditForm({
        subject: data.meeting.subject || '',
        start_time: data.meeting.start_time || '',
        end_time: data.meeting.end_time || '',
        location: data.meeting.location || '',
        description: data.meeting.description || ''
      })
    } catch (error) {
      console.error('Failed to load meeting details:', error)
      setError((error as Error).message || 'Failed to load meeting')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (id) {
      // C-MTG-004: Reset attendee overflow state when navigating to a different meeting
      setShowAllAttendees(false)
      loadMeetingDetails(id)
    }
  }, [id, loadMeetingDetails])

  // Clear playback loading when audio starts playing
  useEffect(() => {
    if (currentlyPlayingId && playbackLoading === currentlyPlayingId) {
      setPlaybackLoading(null)
    }
  }, [currentlyPlayingId, playbackLoading])

  // B-MTG-001: Save edited meeting
  const handleSaveEdit = async () => {
    if (!id || !details) return
    try {
      const updates: Record<string, string | null | undefined> = {}
      if (editForm.subject !== details.meeting.subject) updates.subject = editForm.subject
      if (editForm.location !== (details.meeting.location || '')) updates.location = editForm.location || null
      if (editForm.description !== (details.meeting.description || '')) updates.description = editForm.description || null

      if (Object.keys(updates).length === 0) {
        setIsEditing(false)
        return
      }

      const result = await window.electronAPI.meetings.update({ id, ...updates })
      if (result.success) {
        toast.success('Meeting updated', 'Meeting details have been saved.')
        setIsEditing(false)
        await loadMeetingDetails(id)
      } else {
        toast.error('Failed to update meeting', (result as any).error?.message || 'Unknown error')
      }
    } catch (err) {
      console.error('Failed to update meeting:', err)
      toast.error('Failed to update meeting', err instanceof Error ? err.message : 'Unknown error')
    }
  }

  const handleCancelEdit = () => {
    if (details) {
      setEditForm({
        subject: details.meeting.subject || '',
        start_time: details.meeting.start_time || '',
        end_time: details.meeting.end_time || '',
        location: details.meeting.location || '',
        description: details.meeting.description || ''
      })
    }
    setIsEditing(false)
  }

  // B-MTG-003: Handle play with loading spinner
  const handlePlay = (recordingId: string, filePath: string) => {
    setPlaybackLoading(recordingId)
    audioControls.play(recordingId, filePath)
    // Loading state will be cleared by the useEffect when currentlyPlayingId changes
    // C-MTG-006: Track timeout in ref so it can be cleaned up on unmount
    if (playbackTimeoutRef.current) {
      clearTimeout(playbackTimeoutRef.current)
    }
    playbackTimeoutRef.current = setTimeout(() => {
      setPlaybackLoading(prev => prev === recordingId ? null : prev)
      playbackTimeoutRef.current = null
    }, 5000)
  }

  // B-MTG-002: Handle recording link/unlink
  const handleUnlinkRecording = async (recordingId: string) => {
    try {
      await window.electronAPI.recordings.selectMeeting(recordingId, null)
      toast.success('Recording unlinked', 'Recording has been unlinked from this meeting.')
      if (id) await loadMeetingDetails(id)
    } catch (err) {
      console.error('Failed to unlink recording:', err)
      toast.error('Failed to unlink recording', err instanceof Error ? err.message : 'Unknown error')
    }
  }

  const handleOpenLinkDialog = async (recordingId: string) => {
    setLinkRecordingId(recordingId)
    setLinkDialogOpen(true)
    setLinkLoading(true)
    try {
      const result = await window.electronAPI.recordings.getCandidates(recordingId)
      if (result.success) {
        setAvailableMeetings(result.data)
      }
    } catch (err) {
      console.error('Failed to load meeting candidates:', err)
    } finally {
      setLinkLoading(false)
    }
  }

  const handleLinkToMeeting = async (meetingId: string) => {
    if (!linkRecordingId) return
    try {
      const result = await window.electronAPI.recordings.selectMeeting(linkRecordingId, meetingId)
      if (result.success) {
        toast.success('Recording linked', 'Recording has been linked to the meeting.')
        setLinkDialogOpen(false)
        if (id) await loadMeetingDetails(id)
      } else {
        toast.error('Failed to link recording', result.error || 'Unknown error')
      }
    } catch (err) {
      console.error('Failed to link recording:', err)
      toast.error('Failed to link recording', err instanceof Error ? err.message : 'Unknown error')
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-bg">
        <p className="text-ink-muted">Loading meeting details...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-bg">
        <p className="text-danger">{error}</p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => id && loadMeetingDetails(id)}>
            Retry
          </Button>
          <Button variant="outline" onClick={() => navigate('/calendar')}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Calendar
          </Button>
        </div>
      </div>
    )
  }

  if (!details) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-bg">
        <p className="text-ink-muted">Meeting not found</p>
        <Button variant="outline" onClick={() => navigate('/calendar')}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to Calendar
        </Button>
      </div>
    )
  }

  const { meeting, recordings } = details
  const attendees = parseAttendees(meeting.attendees)
  const startDate = new Date(meeting.start_time)
  const endDate = new Date(meeting.end_time)
  // C-MTG-005: Guard against invalid dates producing NaN
  const rawDuration = (endDate.getTime() - startDate.getTime()) / 60000
  const durationMins = Number.isFinite(rawDuration) ? Math.round(rawDuration) : 0
  const isValidDate = !isNaN(startDate.getTime()) && !isNaN(endDate.getTime())

  // B-MTG-005: Control visible attendees
  const visibleAttendees = showAllAttendees ? attendees : attendees.slice(0, ATTENDEES_COLLAPSED_LIMIT)
  const hasMoreAttendees = attendees.length > ATTENDEES_COLLAPSED_LIMIT

  return (
    <div className="flex h-full flex-col bg-bg">
      {/* Header */}
      <header className="flex items-center gap-4 border-b border-border bg-surface px-[var(--space-5)] py-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate('/calendar')}
          className="text-ink-muted hover:text-ink"
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="min-w-0 flex-1">
          <Eyebrow className="mb-1">Meeting</Eyebrow>
          {isEditing ? (
            <Input
              value={editForm.subject}
              onChange={(e) => setEditForm(prev => ({ ...prev, subject: e.target.value }))}
              className="h-auto py-1 font-display text-[1.75rem] font-semibold tracking-[-0.02em]"
            />
          ) : (
            <h1 className="truncate font-display text-[1.75rem] font-semibold leading-[1.1] tracking-[-0.02em] text-ink">
              {meeting.subject}
            </h1>
          )}
          <p className="mt-1 font-mono text-[11px] text-ink-muted">{formatDateTime(meeting.start_time)}</p>
        </div>
        <div className="flex items-center gap-2">
          {isEditing ? (
            <>
              <Button size="sm" variant="default" onClick={handleSaveEdit}>
                <Check className="mr-2 h-4 w-4" />
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={handleCancelEdit}>
                <X className="mr-2 h-4 w-4" />
                Cancel
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setIsEditing(true)}>
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </Button>
          )}
        </div>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-auto p-[var(--space-5)]">
        <div className="mx-auto max-w-4xl space-y-[var(--space-5)]">
          {/* Meeting Info */}
          <Card className="bg-surface">
            <CardContent className="space-y-4 p-[var(--space-5)]">
              <Eyebrow>Meeting Details</Eyebrow>
              <div className="flex items-center gap-3">
                <Clock className="h-5 w-5 text-ink-muted" />
                <div>
                  {/* C-MTG-003: Timezone-aware time display using safe formatters */}
                  <p className="font-medium text-ink">
                    {safeFormatTime(startDate, { hour: '2-digit', minute: '2-digit' })} -{' '}
                    {safeFormatTime(endDate, { hour: '2-digit', minute: '2-digit' })}
                    {isValidDate && (
                      <span className="ml-1.5 font-mono text-[11px] font-normal text-ink-muted">
                        {safeGetTimezoneName(startDate)}
                      </span>
                    )}
                  </p>
                  <p className="text-sm text-ink-muted">
                    {durationMins} minutes
                    {isValidDate && (
                      <>
                        {' \u00b7 '}
                        {safeFormatDate(startDate, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
                      </>
                    )}
                  </p>
                </div>
              </div>

              {(meeting.location || isEditing) && (
                <div className="flex items-center gap-3">
                  <MapPin className="h-5 w-5 text-ink-muted" />
                  {isEditing ? (
                    <Input
                      value={editForm.location}
                      onChange={(e) => setEditForm(prev => ({ ...prev, location: e.target.value }))}
                      placeholder="Location..."
                      className="flex-1"
                    />
                  ) : (
                    <p className="text-foreground">{meeting.location}</p>
                  )}
                </div>
              )}

              {meeting.organizer_name && (
                <div className="flex items-center gap-3">
                  <Users className="h-5 w-5 text-ink-muted" />
                  <div>
                    <p className="font-medium text-ink">Organizer: {meeting.organizer_name}</p>
                    {meeting.organizer_email && (
                      <p className="text-sm text-ink-muted">{meeting.organizer_email}</p>
                    )}
                  </div>
                </div>
              )}

              {/* B-MTG-005: Attendees with overflow and "Show all" toggle */}
              {attendees.length > 0 && (
                <div>
                  <p className="mb-2 font-medium text-ink">Attendees ({attendees.length})</p>
                  <div className="max-h-40 overflow-auto">
                    <div className="flex flex-wrap gap-2">
                      {visibleAttendees.map((attendee, i) => {
                        const label = attendee.name || attendee.email || 'Unknown'
                        return (
                          <span
                            key={i}
                            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-sunken py-1 pl-1 pr-2.5 text-xs text-ink"
                          >
                            <PersonAvatar name={label} size={20} />
                            {label}
                          </span>
                        )
                      })}
                    </div>
                  </div>
                  {hasMoreAttendees && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mt-2 text-xs"
                      onClick={() => setShowAllAttendees(!showAllAttendees)}
                    >
                      {showAllAttendees ? (
                        <>
                          <ChevronUp className="mr-1 h-3 w-3" />
                          Show less
                        </>
                      ) : (
                        <>
                          <ChevronDown className="mr-1 h-3 w-3" />
                          Show all {attendees.length} attendees
                        </>
                      )}
                    </Button>
                  )}
                </div>
              )}

              {/* Description (editable) */}
              {(meeting.description || isEditing) && (
                <div>
                  <p className="mb-1 font-medium text-ink">Description</p>
                  {isEditing ? (
                    <textarea
                      value={editForm.description}
                      onChange={(e) => setEditForm(prev => ({ ...prev, description: e.target.value }))}
                      className="min-h-[80px] w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground"
                      placeholder="Meeting description..."
                    />
                  ) : (
                    <p className="whitespace-pre-wrap text-sm text-ink-muted">{meeting.description}</p>
                  )}
                </div>
              )}

              {meeting.meeting_url && (
                <div>
                  <a
                    href={meeting.meeting_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-primary hover:underline"
                  >
                    Join Meeting Link
                  </a>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Recordings */}
          <Card className="bg-surface">
            <CardContent className="p-[var(--space-5)]">
              <div className="mb-4 flex items-center gap-2">
                <Mic className="h-4 w-4 text-accent-2" />
                <Eyebrow>Recordings ({recordings.length})</Eyebrow>
              </div>
              {recordings.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <Mic className="mb-3 h-10 w-10 text-ink-muted/40" />
                  <p className="mb-1 font-medium text-ink-muted">No recordings linked</p>
                  <p className="max-w-sm text-sm text-ink-muted/70">
                    Recordings are automatically linked when they overlap with the meeting time.
                    You can also manually link recordings from the Calendar view.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-4"
                    onClick={() => navigate('/calendar')}
                  >
                    Go to Calendar
                  </Button>
                </div>
              ) : (
                <div className="space-y-4">
                  {recordings.map((recording) => (
                    <div key={recording.id} className="rounded-lg border border-border bg-surface-sunken p-4">
                      <div className="mb-2 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Mic className="h-4 w-4 text-accent-2" />
                          <span className="font-medium text-ink">{recording.filename}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="default" size="sm" className="capitalize">
                            {recording.status}
                          </Badge>
                          {/* B-MTG-002: Unlink recording button */}
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleUnlinkRecording(recording.id)}
                            title="Unlink recording from meeting"
                          >
                            <Unlink className="h-4 w-4" />
                          </Button>
                          {/* C-MTG-001: Re-link recording to a different meeting */}
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleOpenLinkDialog(recording.id)}
                            title="Link to a different meeting"
                          >
                            <Link className="h-4 w-4" />
                          </Button>
                          {/* B-MTG-003: Play with loading spinner */}
                          {playbackLoading === recording.id ? (
                            <Loader2 className="h-4 w-4 animate-spin text-ink-muted" />
                          ) : currentlyPlayingId === recording.id ? (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => audioControls.stop()}
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => recording.file_path && handlePlay(recording.id, recording.file_path)}
                              disabled={!recording.file_path}
                              title={recording.file_path ? 'Play recording' : 'Recording not available locally'}
                            >
                              <Play className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      </div>

                      {/* Audio Player */}
                      {currentlyPlayingId === recording.id && recording.file_path && (
                        <div className="my-3">
                          <AudioPlayer
                            filename={recording.filename}
                            onClose={() => audioControls.stop()}
                          />
                        </div>
                      )}

                      {recording.duration_seconds && (
                        <p className="text-sm text-ink-muted">
                          Duration: {formatDuration(recording.duration_seconds)}
                        </p>
                      )}

                      {/* Transcript */}
                      {recording.transcript && (
                        <div className="mt-4 border-t border-border pt-4">
                          <div className="mb-2 flex items-center gap-2">
                            <FileText className="h-4 w-4 text-ink-muted" />
                            <span className="text-sm font-medium text-ink">Transcript</span>
                          </div>

                          {recording.transcript.summary && (
                            <div className="mb-3 rounded-lg border border-border bg-surface p-3">
                              <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-muted">Summary</p>
                              <Markdown>{recording.transcript.summary}</Markdown>
                            </div>
                          )}

                          {recording.transcript.action_items && (
                            <div className="mb-3">
                              <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-muted">
                                Action Items
                              </p>
                              <ul className="list-inside list-disc space-y-1 text-sm text-foreground">
                                {parseJsonArray<string>(recording.transcript.action_items).map(
                                  (item, i) => (
                                    <li key={i}>{item}</li>
                                  )
                                )}
                              </ul>
                            </div>
                          )}

                          <details className="mt-2">
                            <summary className="cursor-pointer text-sm text-primary hover:underline">
                              View full transcript
                            </summary>
                            <p className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-surface p-3 text-sm text-foreground">
                              {recording.transcript.full_text}
                            </p>
                          </details>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* AUD2-002: Actionables Section */}
          {actionablesError ? (
            <Card className="bg-surface">
              <CardContent className="py-6">
                <div className="flex items-center justify-center gap-3 text-sm text-ink-muted">
                  <AlertCircle className="h-4 w-4 text-danger" />
                  <span>{actionablesError}</span>
                  <Button variant="ghost" size="sm" onClick={() => id && loadMeetingDetails(id)}>
                    Retry
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : details.actionables && details.actionables.length > 0 ? (
            <MeetingActionables actionables={details.actionables} />
          ) : null}
        </div>
      </div>

      {/* B-MTG-002: Recording Link Dialog */}
      <Dialog open={linkDialogOpen} onOpenChange={setLinkDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Link Recording to Meeting</DialogTitle>
            <DialogDescription>
              Select a meeting to link this recording to.
            </DialogDescription>
          </DialogHeader>
          {linkLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-ink-muted" />
            </div>
          ) : availableMeetings.length === 0 ? (
            <p className="py-8 text-center text-sm text-ink-muted">
              No candidate meetings found.
            </p>
          ) : (
            <div className="max-h-64 space-y-2 overflow-auto">
              {availableMeetings.map((m: any) => (
                <button
                  key={m.meetingId || m.id}
                  className="w-full rounded-lg border border-border bg-surface p-3 text-left transition-colors hover:border-border-strong hover:bg-surface-hover"
                  onClick={() => handleLinkToMeeting(m.meetingId || m.id)}
                >
                  <p className="text-sm font-medium text-ink">{m.subject}</p>
                  <p className="font-mono text-[11px] text-ink-muted">
                    {formatDateTime(m.startTime || m.start_time)}
                  </p>
                  {m.confidenceScore !== undefined && (
                    <p className="text-xs text-accent-2">
                      Confidence: {Math.round(m.confidenceScore * 100)}%
                    </p>
                  )}
                </button>
              ))}
            </div>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default MeetingDetail
