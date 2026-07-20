import { memo } from 'react'
import {
  Mic,
  FileText,
  Calendar,
  Play,
  X,
  Download,
  RefreshCw,
  Trash2,
  ChevronDown,
  ChevronUp,
  Wand2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { AudioPlayer } from '@/components/AudioPlayer'
import { formatDateTime, formatDuration, formatBytes } from '@/lib/utils'
import { parseJsonArray, Transcript, Meeting } from '@/types'
import { UnifiedRecording, hasLocalPath, isDeviceOnly } from '@/types/unified-recording'
import { StatusIcon } from './StatusIcon'
import { TranscriptionStatusBadge } from './TranscriptionStatusBadge'
import { useLibraryStore } from '@/store/useLibraryStore'
import { CapturePeoplePills } from './CapturePeoplePills'
import { CaptureLabelChips } from './CaptureLabelChips'
import type { CapturePerson, CaptureLabel } from '../types/captureMeta'
import { Markdown } from '@/components/ui/markdown'

// Harbor Badge variant per quality rating.
const QUALITY_VARIANT: Record<string, 'accent' | 'default'> = {
  valuable: 'accent',
  archived: 'default'
}

interface SourceCardProps {
  recording: UnifiedRecording
  transcript?: Transcript
  meeting?: Meeting
  isPlaying: boolean
  isTranscriptExpanded: boolean
  isDownloading: boolean
  downloadProgress?: number
  downloadStage?: 'reading' | 'uploading' | 'saving' | null
  isDeleting: boolean
  deviceConnected: boolean
  deviceSyncing?: boolean
  isSelected?: boolean
  /**
   * Unified click handler. Receives the raw mouse event so the parent can read
   * modifier keys (shift = range select, cmd/ctrl = toggle, plain = open detail).
   */
  onClick?: (e: React.MouseEvent) => void
  onPlay: () => void
  onStop: () => void
  onDownload: () => void
  onDelete: () => void
  onTranscribe?: () => void
  onAskAssistant: () => void
  onGenerateOutput: () => void
  onToggleTranscript: () => void
  onNavigateToMeeting: (meetingId: string) => void
  people?: CapturePerson[]
  labels?: CaptureLabel[]
  peopleKey?: string
  labelsKey?: string
  onOverflowPeopleClick?: () => void
}

export const SourceCard = memo(function SourceCard({
  recording,
  transcript,
  meeting,
  isPlaying,
  isTranscriptExpanded,
  isDownloading,
  downloadProgress,
  downloadStage,
  isDeleting,
  deviceConnected,
  deviceSyncing = false,
  isSelected = false,
  onClick,
  onPlay,
  onStop,
  onDownload,
  onDelete,
  onTranscribe,
  onAskAssistant,
  onGenerateOutput,
  onToggleTranscript,
  onNavigateToMeeting,
  people = [],
  labels = [],
  peopleKey: _peopleKey,
  labelsKey: _labelsKey,
  onOverflowPeopleClick,
}: SourceCardProps) {
  const canPlay = hasLocalPath(recording)
  const error = useLibraryStore((state) => state.recordingErrors.get(recording.id))

  const handleCardClick = (e: React.MouseEvent) => {
    // Don't trigger onClick if clicking on buttons or interactive elements
    const target = e.target as HTMLElement
    if (target.closest('button') || target.closest('a')) {
      return
    }
    onClick?.(e)
  }

  return (
    <Card
      // BULK-selected cards get a distinct teal selection tint + left accent bar
      // (mirrors SourceRow), differentiating multi-select from a plain card.
      className={[
        'cursor-pointer transition-colors border-l-4',
        isSelected ? 'bg-accent-2-soft border-l-accent-2 shadow-sm' : 'border-l-transparent'
      ].join(' ')}
      onClick={handleCardClick}
      data-testid="source-card"
      role="option"
      aria-selected={isPlaying || isSelected}
      data-selected={isSelected || undefined}
      tabIndex={0}
    >
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            {/* Icon tile — selected uses teal accent; otherwise surface-sunken w/ location-colored status icon */}
            <div
              className={[
                'flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-md',
                isSelected ? 'bg-accent-2 text-white' : 'bg-surface-sunken'
              ].join(' ')}
            >
              <StatusIcon recording={recording} />
            </div>
            <div className="min-w-0">
              <CardTitle className="font-display text-[1.125rem] font-semibold tracking-[-0.01em] text-ink">
                {recording.title || recording.filename}
              </CardTitle>
              <CardDescription className="font-mono text-[11px] text-ink-muted">
                {formatDateTime(recording.dateRecorded.toISOString())}
                {recording.size && ` · ${formatBytes(recording.size)}`}
                {recording.duration && ` · ${formatDuration(recording.duration)}`}
              </CardDescription>
              {/* People pills + label chips — visible when data is present */}
              {(people.length > 0 || labels.length > 0) && (
                <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                  <CapturePeoplePills people={people} cap={3} onOverflowClick={onOverflowPeopleClick} />
                  <CaptureLabelChips labels={labels} />
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Quality badge */}
            {recording.quality && (
              <Badge variant={QUALITY_VARIANT[recording.quality] ?? 'default'}>
                {recording.quality}
              </Badge>
            )}

            <Button variant="ghost" size="icon" onClick={onAskAssistant} title="Ask Assistant about this capture">
              <Mic className="h-4 w-4" />
            </Button>

            <Button variant="ghost" size="icon" onClick={onGenerateOutput} title="Generate artifact from this capture">
              <FileText className="h-4 w-4" />
            </Button>

            {/* Transcribe button - for local recordings without transcript */}
            {hasLocalPath(recording) && recording.transcriptionStatus !== 'complete' && onTranscribe && (
              <Button
                variant="ghost"
                size="icon"
                onClick={onTranscribe}
                disabled={recording.transcriptionStatus === 'pending' || recording.transcriptionStatus === 'processing'}
                title={
                  recording.transcriptionStatus === 'pending' ? 'Transcription queued' :
                  recording.transcriptionStatus === 'processing' ? 'Transcription in progress' :
                  'Transcribe this capture'
                }
              >
                {recording.transcriptionStatus === 'processing' ? (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                ) : (
                  <Wand2 className="h-4 w-4" />
                )}
              </Button>
            )}

            {/* Transcription status badge */}
            <TranscriptionStatusBadge status={recording.transcriptionStatus} />

            {/* Download button for device-only recordings */}
            {isDeviceOnly(recording) &&
              (isDownloading ? (
                <div className="flex items-center gap-2 text-xs text-ink-muted">
                  <RefreshCw className="h-4 w-4 animate-spin" />
                  {downloadStage ? { reading: 'Reading', uploading: 'Uploading', saving: 'Saving' }[downloadStage] + ' ' : ''}
                  {downloadProgress ?? 0}%
                </div>
              ) : (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onDownload}
                  disabled={!deviceConnected || deviceSyncing}
                  title={deviceConnected ? 'Download to computer' : 'Device not connected'}
                >
                  <Download className="h-4 w-4" />
                </Button>
              ))}

            {/* Play button */}
            {isPlaying ? (
              <Button variant="ghost" size="icon" onClick={onStop}>
                <X className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon"
                onClick={onPlay}
                disabled={!canPlay || error?.type === 'audio_not_found'}
                title={
                  error?.type === 'audio_not_found'
                    ? 'File missing'
                    : canPlay
                      ? 'Play capture'
                      : 'Download to play'
                }
              >
                <Play className="h-4 w-4" />
              </Button>
            )}

            {/* Delete button */}
            <Button
              variant="ghost"
              size="icon"
              className={
                recording.location === 'device-only'
                  ? 'text-destructive hover:text-destructive'
                  : recording.location === 'local-only'
                  ? 'text-warning hover:text-warning'
                  : 'text-ink-muted hover:text-warning'
              }
              onClick={onDelete}
              disabled={(recording.location === 'device-only' && !deviceConnected) || isDeleting}
              title={
                recording.location === 'device-only'
                  ? 'Delete from device'
                  : recording.location === 'local-only'
                  ? 'Delete local file'
                  : 'Delete local copy'
              }
            >
              {isDeleting ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Audio Player */}
        {isPlaying && hasLocalPath(recording) && (
          <AudioPlayer filename={recording.filename} onClose={onStop} />
        )}

        {/* Linked Meeting */}
        {meeting && (
          <div
            className="flex items-center gap-2 p-3 bg-surface-sunken rounded-lg cursor-pointer hover:bg-surface-hover"
            onClick={() => onNavigateToMeeting(meeting.id)}
          >
            <Calendar className="h-4 w-4 text-accent-2" />
            <div>
              <p className="text-sm font-medium text-ink">{meeting.subject}</p>
              <p className="font-mono text-[11px] text-ink-muted">{formatDateTime(meeting.start_time)}</p>
            </div>
          </div>
        )}

        {/* Transcript */}
        {transcript && (
          <div className="border border-border rounded-lg">
            <button
              className="w-full flex items-center justify-between p-3 hover:bg-surface-hover"
              onClick={onToggleTranscript}
            >
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-ink-muted" />
                <span className="font-medium text-sm text-ink">Transcript</span>
                {transcript.word_count && (
                  <span className="font-mono text-[11px] text-ink-muted">({transcript.word_count} words)</span>
                )}
              </div>
              {isTranscriptExpanded ? <ChevronUp className="h-4 w-4 text-ink-muted" /> : <ChevronDown className="h-4 w-4 text-ink-muted" />}
            </button>

            {isTranscriptExpanded && (
              <div className="p-3 pt-0 space-y-3">
                {/* Summary */}
                {transcript.summary && (
                  <div className="p-3 bg-surface-sunken rounded-lg">
                    <p className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-muted mb-1">Summary</p>
                    <Markdown>{transcript.summary}</Markdown>
                  </div>
                )}

                {/* Action Items */}
                {transcript.action_items && (
                  <div>
                    <p className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-muted mb-1">Action Items</p>
                    <ul className="list-disc list-inside text-sm space-y-1 text-foreground">
                      {parseJsonArray<string>(transcript.action_items).map((item, i) => (
                        <li key={i}>{item}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Key Points */}
                {transcript.key_points && (
                  <div>
                    <p className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-muted mb-1">Key Points</p>
                    <ul className="list-disc list-inside text-sm space-y-1 text-foreground">
                      {parseJsonArray<string>(transcript.key_points).map((item, i) => (
                        <li key={i}>{item}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Topics */}
                {transcript.topics && (
                  <div>
                    <p className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-muted mb-1">Topics</p>
                    <div className="flex flex-wrap gap-1">
                      {parseJsonArray<string>(transcript.topics).map((topic, i) => (
                        <Badge key={i} variant="default" size="sm">
                          {topic}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {/* Full Text */}
                <details className="mt-2">
                  <summary className="text-sm text-accent-2 cursor-pointer hover:underline">View full transcript</summary>
                  <p className="mt-2 text-sm whitespace-pre-wrap bg-surface-sunken p-3 rounded-lg max-h-64 overflow-auto text-foreground">
                    {transcript.full_text}
                  </p>
                </details>

                {/* Metadata */}
                <div className="flex gap-4 font-mono text-[11px] text-ink-muted pt-2 border-t border-border">
                  {transcript.language && <span>Language: {transcript.language}</span>}
                  {transcript.transcription_provider && <span>Provider: {transcript.transcription_provider}</span>}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Device-only notice */}
        {isDeviceOnly(recording) && (
          <p className="text-xs text-ink-muted italic">
            Download this capture to play it and generate a transcript.
          </p>
        )}
      </CardContent>
    </Card>
  )
}, (prevProps, nextProps) => {
  // Custom comparison for performance
  // C-005: Include recording.location and recording.title to detect download and title changes
  return (
    prevProps.recording.id === nextProps.recording.id &&
    prevProps.recording.location === nextProps.recording.location &&
    prevProps.recording.transcriptionStatus === nextProps.recording.transcriptionStatus &&
    prevProps.recording.quality === nextProps.recording.quality &&
    prevProps.recording.title === nextProps.recording.title &&
    prevProps.recording.category === nextProps.recording.category &&
    prevProps.recording.duration === nextProps.recording.duration &&
    prevProps.recording.size === nextProps.recording.size &&
    prevProps.isPlaying === nextProps.isPlaying &&
    prevProps.isTranscriptExpanded === nextProps.isTranscriptExpanded &&
    prevProps.isDownloading === nextProps.isDownloading &&
    prevProps.downloadProgress === nextProps.downloadProgress &&
    prevProps.downloadStage === nextProps.downloadStage &&
    prevProps.isDeleting === nextProps.isDeleting &&
    prevProps.deviceConnected === nextProps.deviceConnected &&
    prevProps.deviceSyncing === nextProps.deviceSyncing &&
    prevProps.isSelected === nextProps.isSelected &&
    prevProps.transcript?.id === nextProps.transcript?.id &&
    prevProps.meeting?.id === nextProps.meeting?.id &&
    prevProps.peopleKey === nextProps.peopleKey &&
    prevProps.labelsKey === nextProps.labelsKey
  )
})
