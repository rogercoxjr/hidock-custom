import { useCallback, useState } from 'react'
import { Play, Pause, Square, X, SkipBack, SkipForward } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useUIStore } from '@/store/useUIStore'
import { useAudioControls } from '@/components/OperationController'
import { WaveformCanvas } from '@/components/WaveformCanvas'
import { formatTimestamp } from '@/utils/audioUtils'

interface AudioPlayerProps {
  filename?: string
  onClose?: () => void
}

/**
 * AudioPlayer component - Enhanced player with waveform visualization
 *
 * The actual audio playback is handled by OperationController.
 * This component displays the playback state, waveform, and controls.
 */
export function AudioPlayer({ filename, onClose }: AudioPlayerProps) {
  // Read playback state from UIStore
  const isPlaying = useUIStore((state) => state.isPlaying)
  const currentTime = useUIStore((state) => state.playbackCurrentTime)
  const duration = useUIStore((state) => state.playbackDuration)
  const waveformData = useUIStore((state) => state.playbackWaveformData)
  const sentimentData = useUIStore((state) => state.playbackSentimentData)

  // Read waveform loading state from UIStore
  const waveformLoadingId = useUIStore((state) => state.waveformLoadingId)
  const waveformLoadingError = useUIStore((state) => state.waveformLoadingError)
  const currentlyPlayingId = useUIStore((state) => state.currentlyPlayingId)

  // Get audio controls from OperationController
  const audioControls = useAudioControls()

  // Local state for playback speed
  const [playbackRate, setPlaybackRate] = useState('1')

  const togglePlay = useCallback(() => {
    if (isPlaying) {
      audioControls.pause()
    } else {
      audioControls.resume()
    }
  }, [isPlaying, audioControls])

  const handleStop = useCallback(() => {
    audioControls.stop()
  }, [audioControls])

  const seekAudio = useCallback(
    (time: number) => {
      if (!duration || duration <= 0) return
      audioControls.seek(time)
    },
    [duration, audioControls]
  )

  const skipBackward = useCallback(() => {
    const newTime = Math.max(0, currentTime - 10)
    audioControls.seek(newTime)
  }, [currentTime, audioControls])

  const skipForward = useCallback(() => {
    const newTime = Math.min(duration, currentTime + 10)
    audioControls.seek(newTime)
  }, [currentTime, duration, audioControls])

  const handlePlaybackRateChange = useCallback(
    (value: string) => {
      setPlaybackRate(value)
      audioControls.setPlaybackRate(parseFloat(value))
    },
    [audioControls]
  )

  // Scrubber progress (0–100%) driving the accent fill + thumb position.
  const progressPct = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0

  // Click-to-seek on the scrubber track.
  const handleScrub = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!duration || duration <= 0) return
      const rect = e.currentTarget.getBoundingClientRect()
      const ratio = (e.clientX - rect.left) / rect.width
      seekAudio(Math.min(duration, Math.max(0, ratio * duration)))
    },
    [duration, seekAudio]
  )

  return (
    <div className="rounded-xl border border-border bg-surface p-4 shadow-sm">
      {/* Filename if provided */}
      {filename && (
        <p className="mb-3 truncate text-sm font-medium text-ink">{filename}</p>
      )}

      {/* Waveform visualization */}
      {waveformData ? (
        <WaveformCanvas
          audioData={waveformData}
          sentimentData={sentimentData || undefined}
          currentTime={currentTime}
          duration={duration}
          onSeek={seekAudio}
          height={46}
        />
      ) : waveformLoadingError && currentlyPlayingId ? (
        <div className="flex h-[46px] flex-col items-center justify-center gap-1 rounded-md bg-danger-soft text-sm">
          <p className="text-danger">Failed to load waveform</p>
          <p className="text-xs text-ink-muted">{waveformLoadingError}</p>
        </div>
      ) : waveformLoadingId && currentlyPlayingId ? (
        <div className="flex h-[46px] items-center justify-center rounded-md bg-surface-sunken">
          <div className="flex h-9 items-end gap-[3px]">
            {Array.from({ length: 40 }).map((_, i) => (
              <div
                key={i}
                className="w-1 animate-pulse rounded-full bg-border-strong"
                style={{
                  height: `${Math.random() * 100}%`,
                  animationDelay: `${i * 20}ms`
                }}
              />
            ))}
          </div>
        </div>
      ) : (
        <div className="flex h-[46px] items-center justify-center rounded-md bg-surface-sunken text-sm text-ink-muted">
          Select a recording to view waveform
        </div>
      )}

      {/* Transport controls */}
      <div className="mt-3.5 flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          className="h-[34px] w-[34px] text-ink hover:text-ink"
          onClick={skipBackward}
          disabled={currentTime <= 0}
        >
          <SkipBack className="h-[19px] w-[19px]" />
        </Button>

        {/* Circular accent Play/Pause button */}
        <button
          type="button"
          onClick={togglePlay}
          className="flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm transition-colors hover:bg-accent-hover"
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
        </button>

        <Button
          variant="ghost"
          size="icon"
          className="h-[34px] w-[34px] text-ink hover:text-ink"
          onClick={skipForward}
          disabled={currentTime >= duration}
        >
          <SkipForward className="h-[19px] w-[19px]" />
        </Button>

        {/* Current time */}
        <span className="w-11 shrink-0 font-mono text-xs text-ink">
          {formatTimestamp(currentTime)}
        </span>

        {/* Scrubber */}
        <div
          onClick={handleScrub}
          className="relative h-1.5 flex-1 cursor-pointer rounded-full bg-surface-sunken"
        >
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-primary"
            style={{ width: `${progressPct}%` }}
          />
          <div
            className="absolute top-1/2 h-[13px] w-[13px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface bg-primary shadow-sm"
            style={{ left: `${progressPct}%` }}
          />
        </div>

        {/* Duration */}
        <span className="w-11 shrink-0 font-mono text-xs text-ink-muted">
          {formatTimestamp(duration)}
        </span>

        {/* Playback speed pill */}
        <Select value={playbackRate} onValueChange={handlePlaybackRateChange}>
          <SelectTrigger className="h-7 w-[68px] rounded-sm border-0 bg-surface-sunken px-2.5 font-mono text-[11px] text-ink">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="0.5">0.5×</SelectItem>
            <SelectItem value="1">1×</SelectItem>
            <SelectItem value="1.5">1.5×</SelectItem>
            <SelectItem value="2">2×</SelectItem>
          </SelectContent>
        </Select>

        {/* Stop */}
        <Button
          variant="ghost"
          size="icon"
          className="h-[34px] w-[34px] text-ink-muted hover:text-ink"
          onClick={handleStop}
          aria-label="Stop"
        >
          <Square className="h-4 w-4" />
        </Button>

        {onClose && (
          <Button
            variant="ghost"
            size="icon"
            className="h-[34px] w-[34px] text-ink-muted hover:text-ink"
            onClick={onClose}
            aria-label="Close player"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  )
}
