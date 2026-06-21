import { AlertCircle, RefreshCw, Usb } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface DeviceDisconnectBannerProps {
  show: boolean
  isReconnecting: boolean
  onNavigateToDevice: () => void
  onRetry?: () => void
}

export function DeviceDisconnectBanner({
  show,
  isReconnecting,
  onNavigateToDevice,
  onRetry
}: DeviceDisconnectBannerProps) {
  if (!show) return null

  return (
    <div className="flex items-center justify-between gap-4 px-6 py-3 bg-warning-soft border-b border-[color-mix(in_oklch,var(--warning)_26%,transparent)]">
      <div className="flex items-center gap-3">
        {isReconnecting ? (
          <RefreshCw className="h-4 w-4 text-warning animate-spin" />
        ) : (
          <AlertCircle className="h-4 w-4 text-warning" />
        )}
        <div>
          <p className="text-sm font-medium text-ink">
            {isReconnecting ? 'Reconnecting to device...' : 'Device disconnected'}
          </p>
          <p className="text-xs text-ink-muted">
            {isReconnecting
              ? 'Please wait while we reconnect to your HiDock.'
              : 'Downloads have been paused. Reconnect to continue.'}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {onRetry && !isReconnecting && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Retry
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={onNavigateToDevice}>
          <Usb className="h-4 w-4 mr-2" />
          Go to Device
        </Button>
      </div>
    </div>
  )
}
