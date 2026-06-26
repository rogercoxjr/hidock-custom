import { Cloud, HardDrive, Check, AlertCircle } from 'lucide-react'
import { UnifiedRecording } from '@/types/unified-recording'

interface StatusIconProps {
  recording: UnifiedRecording
  showError?: boolean
  showLabel?: boolean
}

export function StatusIcon({ recording, showError = false, showLabel = false }: StatusIconProps) {
  // Show error state if applicable
  if (showError) {
    return (
      <div
        className="flex items-center gap-1 text-danger"
        role="img"
        aria-label="Processing error"
        title="Processing error"
      >
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        {showLabel && <span className="text-xs hidden sm:inline">Error</span>}
      </div>
    )
  }

  switch (recording.location) {
    case 'device-only':
      return (
        <div
          className="flex items-center gap-1 text-warning"
          role="img"
          aria-label="On device only"
          title="On device only"
        >
          <Cloud className="h-4 w-4" aria-hidden="true" />
          {showLabel && <span className="text-xs hidden sm:inline">On Device</span>}
        </div>
      )
    case 'local-only':
      return (
        <div
          className="flex items-center gap-1 text-accent-strong"
          role="img"
          aria-label="Downloaded"
          title="Downloaded"
        >
          <HardDrive className="h-4 w-4" aria-hidden="true" />
          {showLabel && <span className="text-xs hidden sm:inline">Downloaded</span>}
        </div>
      )
    case 'both':
      return (
        <div
          className="flex items-center gap-1 text-success"
          role="img"
          aria-label="Synced"
          title="Synced"
        >
          <Check className="h-4 w-4" aria-hidden="true" />
          {showLabel && <span className="text-xs hidden sm:inline">Synced</span>}
        </div>
      )
    default:
      return null
  }
}
