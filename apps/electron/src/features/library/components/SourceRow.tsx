import { memo } from 'react'
import { Play, X, AlertCircle, Download, Trash2, Wand2, Mic, FileText, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { formatDate, formatDuration } from '@/lib/utils'
import { Meeting, Transcript, parseJsonArray } from '@/types'
import { UnifiedRecording, hasLocalPath } from '@/types/unified-recording'
import { StatusIcon } from './StatusIcon'
import { TranscriptionStatusBadge } from './TranscriptionStatusBadge'
import { useLibraryStore } from '@/store/useLibraryStore'
import { getDisplayTitle } from '@/features/library/utils/getDisplayTitle'
import { highlightText } from '@/features/library/utils/highlightText'

// Derive an "insight count" (action items + key points) for the accent badge.
function insightCount(transcript?: Transcript): number {
  if (!transcript) return 0
  const actions = transcript.action_items ? parseJsonArray<string>(transcript.action_items).length : 0
  const points = transcript.key_points ? parseJsonArray<string>(transcript.key_points).length : 0
  return actions + points
}

interface SourceRowProps {
  recording: UnifiedRecording
  meeting?: Meeting
  transcript?: Transcript
  isPlaying: boolean
  isSelected?: boolean
  isActiveSource?: boolean
  searchQuery?: string
  onSelectionChange?: (id: string, shiftKey: boolean) => void
  onClick?: () => void
  onPlay: () => void
  onStop: () => void
  // Action handlers
  onDownload?: () => void
  onDelete?: () => void
  onTranscribe?: () => void
  onAskAssistant?: () => void
  onGenerateOutput?: () => void
  // Download state for device-only recordings
  isDownloading?: boolean
  downloadProgress?: number
  deviceConnected?: boolean
}

export const SourceRow = memo(function SourceRow({
  recording,
  meeting,
  transcript,
  isPlaying,
  isSelected = false,
  isActiveSource = false,
  searchQuery = '',
  onSelectionChange,
  onClick,
  onPlay,
  onStop,
  onDownload,
  onDelete,
  onTranscribe,
  onAskAssistant,
  onGenerateOutput,
  isDownloading = false,
  downloadProgress,
  deviceConnected = false
}: SourceRowProps) {
  const canPlay = hasLocalPath(recording)
  const error = useLibraryStore((state) => state.recordingErrors.get(recording.id))

  // Smart title
  const { primaryText, source: titleSource } = getDisplayTitle(recording, meeting, transcript)
  const showFilenameInSecondary = titleSource !== 'filename'

  const handleCheckboxClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    onSelectionChange?.(recording.id, e.shiftKey)
  }

  const handleRowClick = (e: React.MouseEvent) => {
    // Don't trigger onClick if clicking on buttons or checkbox
    const target = e.target as HTMLElement
    if (target.closest('button') || target.closest('[role="checkbox"]')) {
      return
    }
    onClick?.()
  }

  // Build secondary line: date + duration + filename (when title isn't filename)
  const secondaryParts: string[] = []
  secondaryParts.push(formatDate(recording.dateRecorded))
  if (recording.duration) {
    secondaryParts.push(formatDuration(recording.duration))
  }
  if (showFilenameInSecondary) {
    secondaryParts.push(recording.filename)
  }
  const secondaryText = secondaryParts.join(' \u00B7 ')
  const insights = insightCount(transcript)

  return (
    <div
      className={[
        '@container flex items-center justify-between py-2 px-3 hover:bg-surface-hover cursor-pointer transition-colors',
        isSelected ? 'bg-accent-strong-soft border-l-2 border-l-accent-strong/50' : 'border-l-2 border-l-transparent',
        isActiveSource ? 'bg-accent-strong-soft border-l-primary' : ''
      ].filter(Boolean).join(' ')}
      role="option"
      onClick={handleRowClick}
      aria-selected={isPlaying || isSelected}
      tabIndex={0}
    >
      <div className="flex items-center gap-2.5 min-w-0 flex-1">
        {onSelectionChange && (
          <Checkbox
            checked={isSelected}
            onClick={handleCheckboxClick}
            aria-label={`Select ${recording.filename}`}
            className="shrink-0"
          />
        )}
        {/* Icon tile — selected uses bg-primary; otherwise surface-sunken with location-colored status icon */}
        <div
          className={[
            'flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-md',
            isActiveSource ? 'bg-primary text-primary-foreground' : 'bg-surface-sunken'
          ].join(' ')}
        >
          <StatusIcon recording={recording} />
        </div>
        <TranscriptionStatusBadge status={recording.transcriptionStatus} compact />

        {/* Content area — flex-1 to fill remaining space */}
        <div className="flex-1 min-w-0">
          <p className="text-[13.5px] font-semibold truncate text-ink leading-tight">
            {searchQuery ? highlightText(primaryText, searchQuery) : primaryText}
          </p>
          <p className="font-mono text-[10.5px] text-ink-muted truncate leading-tight mt-0.5">
            {searchQuery ? highlightText(secondaryText, searchQuery) : secondaryText}
          </p>
        </div>

        {/* Insight count badge (accent-2-soft) */}
        {insights > 0 && (
          <span
            className="shrink-0 rounded-full bg-accent-2-soft px-[7px] py-0.5 font-mono text-[10px] font-semibold text-accent-2"
            title={`${insights} insight${insights === 1 ? '' : 's'}`}
          >
            {insights}
          </span>
        )}
      </div>

      {/* Action area — action buttons, play button, and error indicator */}
      <div className="flex items-center gap-1 shrink-0 ml-2">
        {/* Error indicator */}
        {error && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <AlertCircle className="h-3.5 w-3.5 text-danger shrink-0" />
              </TooltipTrigger>
              <TooltipContent>
                <p>{error.message}</p>
                {error.details && <p className="text-xs text-ink-muted mt-1">{error.details}</p>}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}

        {/* Ask Assistant button */}
        {onAskAssistant && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={(e) => { e.stopPropagation(); onAskAssistant(); }}
            title="Ask Assistant about this capture"
          >
            <Mic className="h-3.5 w-3.5" />
          </Button>
        )}

        {/* Generate Output button */}
        {onGenerateOutput && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={(e) => { e.stopPropagation(); onGenerateOutput(); }}
            title="Generate artifact from this capture"
          >
            <FileText className="h-3.5 w-3.5" />
          </Button>
        )}

        {/* Transcribe button - only for local recordings without complete transcript */}
        {hasLocalPath(recording) && recording.transcriptionStatus !== 'complete' && onTranscribe && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={(e) => { e.stopPropagation(); onTranscribe(); }}
            disabled={recording.transcriptionStatus === 'pending' || recording.transcriptionStatus === 'processing'}
            title={
              recording.transcriptionStatus === 'pending' ? 'Transcription queued' :
              recording.transcriptionStatus === 'processing' ? 'Transcription in progress' :
              'Transcribe this capture'
            }
          >
            {recording.transcriptionStatus === 'processing' ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Wand2 className="h-3.5 w-3.5" />
            )}
          </Button>
        )}

        {/* Download button - only for device-only recordings */}
        {recording.location === 'device-only' && onDownload && (
          isDownloading ? (
            <div className="flex items-center gap-1 text-xs text-ink-muted px-2">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              <span>{downloadProgress ?? 0}%</span>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={(e) => { e.stopPropagation(); onDownload(); }}
              disabled={!deviceConnected}
              title={deviceConnected ? 'Download to computer' : 'Device not connected'}
            >
              <Download className="h-3.5 w-3.5" />
            </Button>
          )
        )}

        {/* Play/Stop button */}
        {isPlaying ? (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={(e) => { e.stopPropagation(); onStop(); }}
            title="Stop playback"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={(e) => { e.stopPropagation(); onPlay(); }}
            disabled={!canPlay || error?.type === 'audio_not_found'}
            title={
              error?.type === 'audio_not_found'
                ? 'File missing'
                : canPlay
                  ? 'Play capture'
                  : 'Download to play'
            }
          >
            <Play className="h-3.5 w-3.5" />
          </Button>
        )}

        {/* Delete button */}
        {onDelete && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className={
              recording.location === 'device-only'
                ? 'text-destructive hover:text-destructive'
                : recording.location === 'local-only'
                  ? 'text-warning hover:text-warning'
                  : 'text-ink-muted hover:text-warning'
            }
            title={
              recording.location === 'device-only'
                ? 'Delete from device (permanent)'
                : recording.location === 'local-only'
                  ? 'Delete from computer (permanent)'
                  : 'Delete from device and computer'
            }
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  )
}, (prevProps, nextProps) => {
  // Custom comparison for performance
  // LB-16 fix: Include recording.location in equality check to detect download state changes
  return (
    prevProps.recording.id === nextProps.recording.id &&
    prevProps.recording.location === nextProps.recording.location &&
    prevProps.recording.transcriptionStatus === nextProps.recording.transcriptionStatus &&
    prevProps.recording.title === nextProps.recording.title &&
    prevProps.recording.meetingSubject === nextProps.recording.meetingSubject &&
    prevProps.recording.category === nextProps.recording.category &&
    prevProps.recording.quality === nextProps.recording.quality &&
    prevProps.recording.duration === nextProps.recording.duration &&
    prevProps.recording.size === nextProps.recording.size &&
    prevProps.isPlaying === nextProps.isPlaying &&
    prevProps.isSelected === nextProps.isSelected &&
    prevProps.isActiveSource === nextProps.isActiveSource &&
    prevProps.transcript?.id === nextProps.transcript?.id &&
    prevProps.transcript?.title_suggestion === nextProps.transcript?.title_suggestion &&
    prevProps.meeting?.id === nextProps.meeting?.id &&
    prevProps.meeting?.subject === nextProps.meeting?.subject &&
    prevProps.searchQuery === nextProps.searchQuery &&
    // Include callback props to detect when they change
    prevProps.onSelectionChange === nextProps.onSelectionChange &&
    prevProps.onClick === nextProps.onClick
  )
})
