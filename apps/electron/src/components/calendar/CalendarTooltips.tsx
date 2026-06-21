/**
 * Tooltip content components for calendar recordings and meetings
 */

import { memo } from 'react'
import { Mic, Cloud, HardDrive, Check } from 'lucide-react'
import { cn, formatTime } from '@/lib/utils'
import type { CalendarRecording, CalendarMeetingOverlay, CalendarMeeting } from '@/lib/calendar-utils'
import { formatDurationStr as formatDuration } from '@/lib/calendar-utils'

type RecordingLocation = 'device-only' | 'local-only' | 'both'

/**
 * Status icon for recording location
 */
export const StatusIcon = memo(function StatusIcon({ location }: { location: RecordingLocation }) {
  switch (location) {
    case 'device-only':
      return <Cloud className="h-3 w-3 text-warning" />
    case 'local-only':
      return <HardDrive className="h-3 w-3 text-accent-strong" />
    case 'both':
      return <Check className="h-3 w-3 text-success" />
  }
})

/**
 * Recording-centric tooltip (RECORDING INFO FIRST, meeting as metadata)
 */
export const RecordingTooltipContent = memo(function RecordingTooltipContent({ recording }: { recording: CalendarRecording }) {
  return (
    <div className="max-w-[280px] space-y-2">
      {/* RECORDING INFO - PRIMARY */}
      <div className="space-y-1">
        <div className="flex items-center gap-2 font-semibold text-ink">
          <Mic className="h-4 w-4 text-accent-strong" />
          Recording
        </div>
        <div className="space-y-1 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-ink-muted">File:</span>
            <span className="truncate font-mono text-[11px]">{recording.filename}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-ink-muted">Recorded:</span>
            <span>
              {formatTime(recording.startTime.toISOString())} - {formatTime(recording.endTime.toISOString())}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-ink-muted">Duration:</span>
            <span className="font-medium">{formatDuration(recording.durationSeconds)}</span>
          </div>
          {/* Location status */}
          <div className="flex items-center gap-2">
            <span className="text-ink-muted">Status:</span>
            <span
              className={cn(
                'flex items-center gap-1',
                recording.location === 'device-only' && 'text-warning',
                recording.location === 'local-only' && 'text-accent-strong',
                recording.location === 'both' && 'text-success'
              )}
            >
              <StatusIcon location={recording.location} />
              {recording.location === 'device-only' && 'On device only'}
              {recording.location === 'local-only' && 'Downloaded'}
              {recording.location === 'both' && 'Synced'}
            </span>
          </div>
          {/* Transcription status */}
          {recording.transcriptionStatus !== 'none' && (
            <div className="flex items-center gap-2">
              <span className="text-ink-muted">Transcript:</span>
              <span
                className={cn(
                  recording.transcriptionStatus === 'complete' && 'text-success',
                  recording.transcriptionStatus === 'processing' && 'text-warning',
                  recording.transcriptionStatus === 'error' && 'text-danger'
                )}
              >
                {recording.transcriptionStatus}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* MEETING INFO - SECONDARY/METADATA */}
      {recording.linkedMeeting && (
        <div className="space-y-1 border-t border-dashed border-border pt-2">
          <div className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-muted">Linked Meeting</div>
          <div className="space-y-1 text-xs">
            <div className="font-medium">{recording.linkedMeeting.subject}</div>
            <div className="flex items-center gap-2 text-ink-muted">
              <span>Scheduled:</span>
              <span>
                {formatTime(recording.linkedMeeting.startTime.toISOString())} -{' '}
                {formatTime(recording.linkedMeeting.endTime.toISOString())}
              </span>
            </div>
            {recording.linkedMeeting.organizer && (
              <div className="truncate text-ink-muted">By: {recording.linkedMeeting.organizer}</div>
            )}
          </div>
        </div>
      )}

      {!recording.linkedMeeting && (
        <div className="border-t border-dashed border-border pt-2">
          <div className="text-xs italic text-ink-muted">No matching meeting found</div>
        </div>
      )}

      <div className="border-t border-border pt-1 text-xs text-ink-muted">Click for details</div>
    </div>
  )
})

/**
 * Meeting overlay tooltip (for meetings without recordings - dashed display)
 */
export const MeetingOverlayTooltipContent = memo(function MeetingOverlayTooltipContent({ meeting }: { meeting: CalendarMeetingOverlay }) {
  const duration = (meeting.endTime.getTime() - meeting.startTime.getTime()) / 1000
  return (
    <div className="max-w-[280px] space-y-2">
      <div className="font-semibold text-ink-muted">{meeting.subject}</div>
      <div className="space-y-1 text-xs">
        <div className="flex items-center gap-2">
          <span className="text-ink-muted">Scheduled:</span>
          <span>
            {formatTime(meeting.startTime.toISOString())} - {formatTime(meeting.endTime.toISOString())}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-ink-muted">Duration:</span>
          <span>{formatDuration(duration)}</span>
        </div>
        {meeting.organizer && (
          <div className="flex items-center gap-2">
            <span className="text-ink-muted">Organizer:</span>
            <span className="truncate">{meeting.organizer}</span>
          </div>
        )}
        <div className="mt-1 italic text-warning">No recording captured</div>
      </div>
    </div>
  )
})

/**
 * Legacy meeting tooltip (for backwards compatibility)
 */
export const MeetingTooltipContent = memo(function MeetingTooltipContent({ meeting }: { meeting: CalendarMeeting }) {
  const startTime = new Date(meeting.start_time)
  const endTime = new Date(meeting.end_time)
  const meetingDurationSeconds = (endTime.getTime() - startTime.getTime()) / 1000

  return (
    <div className="max-w-[280px] space-y-2">
      <div className="font-semibold text-ink">{meeting.subject}</div>
      <div className="space-y-1 text-xs">
        <div className="flex items-center gap-2">
          <span className="text-ink-muted">Time:</span>
          <span>
            {formatTime(meeting.start_time)} - {formatTime(meeting.end_time)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-ink-muted">Scheduled:</span>
          <span>{formatDuration(meetingDurationSeconds)}</span>
        </div>
        {meeting.hasRecording && meeting.recordingDurationSeconds && (
          <div className="flex items-center gap-2">
            <span className="text-ink-muted">Recorded:</span>
            <span>{formatDuration(meeting.recordingDurationSeconds)}</span>
          </div>
        )}
        {meeting.organizer_name && (
          <div className="flex items-center gap-2">
            <span className="text-ink-muted">Organizer:</span>
            <span className="truncate">{meeting.organizer_name}</span>
          </div>
        )}
        {meeting.location && (
          <div className="flex items-center gap-2">
            <span className="text-ink-muted">Location:</span>
            <span className="truncate">{meeting.location}</span>
          </div>
        )}
        {meeting.hasRecording && (
          <div className="flex items-center gap-2 text-success">
            <Mic className="h-3 w-3" />
            <span>Recording available</span>
          </div>
        )}
        {!meeting.hasRecording && !meeting.isPlaceholder && (
          <div className="italic text-warning">No recording captured</div>
        )}
      </div>
      <div className="border-t border-border pt-1 text-xs text-ink-muted">Click for details</div>
    </div>
  )
})
