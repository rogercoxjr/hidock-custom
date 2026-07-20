import { memo } from 'react'
import {
  Play,
  Square,
  AlertCircle,
  Download,
  Trash2,
  Wand2,
  Mic,
  FileText,
  RefreshCw,
  MoreHorizontal,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { formatDate, formatDuration } from '@/lib/utils'
import { Meeting, Transcript, parseJsonArray } from '@/types'
import { UnifiedRecording, hasLocalPath } from '@/types/unified-recording'
import { StatusIcon } from './StatusIcon'
import { useLibraryStore } from '@/store/useLibraryStore'
import { getDisplayTitle } from '@/features/library/utils/getDisplayTitle'
import { highlightText } from '@/features/library/utils/highlightText'
import { CapturePeoplePills } from './CapturePeoplePills'
import { CaptureLabelChips } from './CaptureLabelChips'
import type { CapturePerson, CaptureLabel } from '../types/captureMeta'

// Derive an "insight count" (action items + key points) for the accent badge.
function insightCount(transcript?: Transcript): number {
  if (!transcript) return 0
  const actions = transcript.action_items ? parseJsonArray<string>(transcript.action_items).length : 0
  const points = transcript.key_points ? parseJsonArray<string>(transcript.key_points).length : 0
  return actions + points
}

// Location → Harbor Badge variant + label for the status pill
const LOCATION_BADGE: Record<string, { variant: 'default' | 'warning' | 'primary' | 'success'; label: string }> = {
  'device-only': { variant: 'warning', label: 'On Device' },
  'local-only':  { variant: 'primary', label: 'Downloaded' },
  'both':        { variant: 'success', label: 'Synced' },
}

interface SourceRowProps {
  recording: UnifiedRecording
  meeting?: Meeting
  transcript?: Transcript
  isPlaying: boolean
  isSelected?: boolean
  isActiveSource?: boolean
  searchQuery?: string
  /**
   * Unified click handler. Receives the raw mouse event so the parent can read
   * modifier keys (shift = range select, cmd/ctrl = toggle, plain = open detail).
   */
  onClick?: (e: React.MouseEvent) => void
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
  downloadStage?: 'reading' | 'uploading' | 'saving' | null
  deviceConnected?: boolean
  /** Pre-derived people for the pills row (from meeting attendees, slice 1). */
  people?: CapturePerson[]
  /** Pre-derived labels for the chip row (category, slice 1). */
  labels?: CaptureLabel[]
  /** Stable primitive key for people array — used in memo comparator. */
  peopleKey?: string
  /** Stable primitive key for labels array — used in memo comparator. */
  labelsKey?: string
  /** Called when overflow "+N" pill is clicked (opens source reader). */
  onOverflowPeopleClick?: () => void
}

export const SourceRow = memo(function SourceRow({
  recording,
  meeting,
  transcript,
  isPlaying,
  isSelected = false,
  isActiveSource = false,
  searchQuery = '',
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
  downloadStage,
  deviceConnected = false,
  people = [],
  labels = [],
  peopleKey: _peopleKey,
  labelsKey: _labelsKey,
  onOverflowPeopleClick,
}: SourceRowProps) {
  const canPlay = hasLocalPath(recording)
  const error = useLibraryStore((state) => state.recordingErrors.get(recording.id))

  // Smart title
  const { primaryText, source: titleSource } = getDisplayTitle(recording, meeting, transcript)
  const showFilenameInSecondary = titleSource !== 'filename'

  const handleRowClick = (e: React.MouseEvent) => {
    // Don't trigger onClick if clicking on buttons or dropdown content
    const target = e.target as HTMLElement
    if (
      target.closest('button') ||
      target.closest('[data-radix-popper-content-wrapper]')
    ) {
      return
    }
    onClick?.(e)
  }

  // Secondary line: date · duration (· filename when title isn't the filename)
  const secondaryParts: string[] = [formatDate(recording.dateRecorded)]
  if (recording.duration) secondaryParts.push(formatDuration(recording.duration))
  if (showFilenameInSecondary) secondaryParts.push(recording.filename)
  const secondaryText = secondaryParts.join(' · ')

  const insights = insightCount(transcript)
  const locationBadge = LOCATION_BADGE[recording.location]

  // Overflow menu shown when secondary actions exist and we're not mid-download
  const hasSecondaryActions = !!(onTranscribe || onDownload || onAskAssistant || onGenerateOutput || onDelete)

  return (
    <div
      className={[
        // Visual state by BACKGROUND TINT only (Harbor forbids colored left-border cards):
        //  • OPEN/active source (isActiveSource) → blue accent-soft tint (wins when also selected,
        //    so the open row stays identifiable inside a multi-selection)
        //  • BULK-selected (isSelected) → teal selection tint
        //  • neither → hover tint
        'group @container flex items-center justify-between py-2 px-3 cursor-pointer transition-colors',
        isActiveSource ? 'bg-accent-strong-soft' : isSelected ? 'bg-accent-2-soft' : 'hover:bg-surface-hover',
      ].filter(Boolean).join(' ')}
      role="option"
      onClick={handleRowClick}
      aria-selected={isPlaying || isSelected}
      data-selected={isSelected || undefined}
      tabIndex={0}
    >
      {/* Left: icon tile + content */}
      <div className="flex items-center gap-2.5 min-w-0 flex-1">
        {/* Icon tile — active source uses bg-primary, otherwise surface-sunken */}
        <div
          className={[
            'flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-md',
            isActiveSource ? 'bg-primary text-primary-foreground' : 'bg-surface-sunken',
          ].join(' ')}
        >
          <StatusIcon recording={recording} />
        </div>

        {/* Content area: primary title + secondary meta line */}
        <div className="flex-1 min-w-0">
          <p className="text-[13.5px] font-semibold truncate text-ink leading-tight">
            {searchQuery ? highlightText(primaryText, searchQuery) : primaryText}
          </p>
          <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
            <p className="font-mono text-[10.5px] text-ink-muted truncate leading-tight">
              {searchQuery ? highlightText(secondaryText, searchQuery) : secondaryText}
            </p>
            {/* Status pill with label */}
            {locationBadge && (
              <Badge variant={locationBadge.variant} size="sm" className="shrink-0">
                {locationBadge.label}
              </Badge>
            )}
          </div>
          {/* People pills + label chips — visible when data is present */}
          {(people.length > 0 || labels.length > 0) && (
            <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
              <CapturePeoplePills people={people} cap={3} onOverflowClick={onOverflowPeopleClick} />
              <CaptureLabelChips labels={labels} />
            </div>
          )}
        </div>

        {/* Insight count badge (accent-2-soft) */}
        {insights > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="shrink-0 rounded-full bg-accent-2-soft px-[7px] py-0.5 font-mono text-[10px] font-semibold text-accent-2"
              >
                {insights}
              </span>
            </TooltipTrigger>
            <TooltipContent>{`${insights} insight${insights === 1 ? '' : 's'}`}</TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* Right: error indicator + downloading state + overflow kebab + play/stop */}
      <div className="flex items-center gap-1 shrink-0 ml-2">
        {/* Error indicator — always visible (actionable signal) */}
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

        {/* Downloading in-progress indicator */}
        {isDownloading && (
          <div className="flex items-center gap-1 text-xs text-ink-muted px-1">
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            <span>
              {downloadStage ? { reading: 'Reading', uploading: 'Uploading', saving: 'Saving' }[downloadStage] + ' ' : ''}
              {downloadProgress ?? 0}%
            </span>
          </div>
        )}

        {/* Overflow kebab — hover/focus-reveal via group; hidden when downloading */}
        {hasSecondaryActions && !isDownloading && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="opacity-0 group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100 transition-opacity"
                onClick={(e) => e.stopPropagation()}
                aria-label="More actions"
                data-testid="source-row-overflow"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48" onClick={(e) => e.stopPropagation()}>
              {/* Transcribe — only for local recordings without a complete transcript */}
              {onTranscribe && hasLocalPath(recording) && recording.transcriptionStatus !== 'complete' && (
                <DropdownMenuItem
                  onSelect={() => onTranscribe()}
                  disabled={
                    recording.transcriptionStatus === 'pending' ||
                    recording.transcriptionStatus === 'processing'
                  }
                >
                  {recording.transcriptionStatus === 'processing' ? (
                    <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Wand2 className="mr-2 h-4 w-4" />
                  )}
                  {recording.transcriptionStatus === 'pending'
                    ? 'Transcription Queued'
                    : recording.transcriptionStatus === 'processing'
                      ? 'Transcribing…'
                      : 'Transcribe'}
                </DropdownMenuItem>
              )}

              {/* Download — only for device-only recordings */}
              {onDownload && recording.location === 'device-only' && (
                <DropdownMenuItem onSelect={() => onDownload()} disabled={!deviceConnected}>
                  <Download className="mr-2 h-4 w-4" />
                  {deviceConnected ? 'Download' : 'Device not connected'}
                </DropdownMenuItem>
              )}

              {onAskAssistant && (
                <DropdownMenuItem onSelect={() => onAskAssistant()}>
                  <Mic className="mr-2 h-4 w-4" />
                  Ask Assistant
                </DropdownMenuItem>
              )}

              {onGenerateOutput && (
                <DropdownMenuItem onSelect={() => onGenerateOutput()}>
                  <FileText className="mr-2 h-4 w-4" />
                  Generate Output
                </DropdownMenuItem>
              )}

              {onDelete && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => onDelete()}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    {recording.location === 'device-only'
                      ? 'Delete from Device'
                      : recording.location === 'local-only'
                        ? 'Delete Local File'
                        : 'Delete'}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {/* Play / Stop — always visible */}
        {isPlaying ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={(e) => { e.stopPropagation(); onStop() }}
                aria-label="Stop playback"
              >
                <Square className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Stop playback</TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={(e) => { e.stopPropagation(); onPlay() }}
                disabled={!canPlay || error?.type === 'audio_not_found'}
                aria-label={
                  error?.type === 'audio_not_found'
                    ? 'File missing'
                    : canPlay
                      ? 'Play capture'
                      : 'Download to play'
                }
              >
                <Play className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {error?.type === 'audio_not_found'
                ? 'File missing'
                : canPlay
                  ? 'Play capture'
                  : 'Download to play'}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  )
}, (prevProps, nextProps) => {
  // Custom comparison for performance — include all fields that affect rendering
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
    prevProps.isDownloading === nextProps.isDownloading &&
    prevProps.downloadProgress === nextProps.downloadProgress &&
    prevProps.downloadStage === nextProps.downloadStage &&
    prevProps.transcript?.id === nextProps.transcript?.id &&
    prevProps.transcript?.title_suggestion === nextProps.transcript?.title_suggestion &&
    prevProps.meeting?.id === nextProps.meeting?.id &&
    prevProps.meeting?.subject === nextProps.meeting?.subject &&
    prevProps.searchQuery === nextProps.searchQuery &&
    prevProps.peopleKey === nextProps.peopleKey &&
    prevProps.labelsKey === nextProps.labelsKey &&
    prevProps.onClick === nextProps.onClick
  )
})
