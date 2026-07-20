import { useState, useEffect, useCallback } from 'react'
import { X, Download, Sparkles, RefreshCw, AlertCircle, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useDownloadQueue, useDeviceSyncProgress, useDeviceSyncEta, useDeviceFileStage, useDeviceFileDownloading } from '@/store/useAppStore'
import { getHiDockDeviceService } from '@/services/hidock-device'
import { useTranscriptionStore, useTranscriptionStats } from '@/store/features/useTranscriptionStore'
import { useOperations } from '@/hooks/useOperations'
import { retryFailedDownloads } from '@/hooks/useDownloadOrchestrator'
import { toast } from '@/components/ui/toaster'
import { formatEta } from '@/utils/formatters'

interface OperationsPanelProps {
  sidebarOpen: boolean
}

export function OperationsPanel({ sidebarOpen }: OperationsPanelProps) {
  // SM-06 fix: Use granular selector exports
  // Note: downloadQueue is a Map reference. Zustand's default Object.is equality check
  // always sees a new Map as different, causing re-renders on every store update even if
  // the map contents haven't changed. A custom equality function or normalized state shape
  // would be needed to optimize this, but the panel is small enough that frequent re-renders
  // are acceptable.
  const downloadQueue = useDownloadQueue()
  const deviceSyncProgress = useDeviceSyncProgress()
  const deviceSyncEta = useDeviceSyncEta()
  const deviceFileStage = useDeviceFileStage()
  const deviceFileDownloading = useDeviceFileDownloading()
  const STAGE_LABEL: Record<'reading' | 'uploading' | 'saving', string> = {
    reading: 'Reading from device…', uploading: 'Uploading…', saving: 'Saving…',
  }
  const transcriptionStats = useTranscriptionStats()
  const transcriptionQueue = useTranscriptionStore((s) => s.queue)
  const { cancelAllDownloads, cancelAllTranscriptions, cancelTranscription } = useOperations()

  // DL-15: Track failed download count for retry button
  const [failedDownloadCount, setFailedDownloadCount] = useState(0)

  useEffect(() => {
    if (!window.electronAPI?.downloadService) return

    // Load initial state
    window.electronAPI.downloadService.getState().then((state) => {
      const failedCount = state?.queue?.filter((item: { status: string }) => item.status === 'failed').length ?? 0
      setFailedDownloadCount(failedCount)
    }).catch(() => {})

    // Subscribe to updates
    const unsub = window.electronAPI.downloadService.onStateUpdate((state: { queue: Array<{ status: string }> }) => {
      const failedCount = state.queue.filter((item) => item.status === 'failed').length
      setFailedDownloadCount(failedCount)
    })
    return unsub
  }, [])

  const handleRetryFailed = useCallback(async () => {
    try {
      // AUD4-016: Pass device connection state so retryFailed can reject when disconnected
      const deviceConnected = getHiDockDeviceService().isConnected()
      // retryFailedDownloads re-queues failed items AND kicks the download loop (the
      // opportunistic gate is unreliable on an already-connected device).
      const result = await retryFailedDownloads(deviceConnected)
      if (result.error) {
        toast({
          title: 'Cannot retry downloads',
          description: result.error,
          variant: 'error'
        })
      } else if (result.count > 0) {
        toast({
          title: 'Retrying downloads',
          description: `Re-queued ${result.count} failed download${result.count !== 1 ? 's' : ''}`,
          variant: 'default'
        })
      }
    } catch (e) {
      console.error('[OperationsPanel] Failed to retry downloads:', e)
    }
  }, [])

  const hasDownloads = downloadQueue.size > 0
  // DL-15: Also show panel when there are failed downloads (for retry button)
  const hasFailedDownloads = failedDownloadCount > 0
  const hasTranscriptions = transcriptionStats.pending > 0 || transcriptionStats.processing > 0 || transcriptionStats.failed > 0
  const hasAnyOperations = hasDownloads || hasFailedDownloads || hasTranscriptions

  if (!hasAnyOperations) return null

  return (
    <div className="border-t border-border px-2 py-2 space-y-2">
      {/* Downloads Section */}
      {/* TODO: DL-04: Individual ad-hoc downloads should show aggregate progress. */}
      {(hasDownloads || hasFailedDownloads) && (
        <div className="space-y-1">
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-1.5 text-xs text-ink">
              <Download className={`h-3 w-3 ${hasDownloads ? 'text-success animate-pulse' : 'text-warning'}`} />
              {sidebarOpen ? (
                <span>
                  {hasDownloads ? 'Downloads' : 'Downloads'}{' '}
                  {deviceSyncProgress
                    ? `(${deviceSyncProgress.current}/${deviceSyncProgress.total})`
                    : hasDownloads
                      ? `(${downloadQueue.size})`
                      : `(${failedDownloadCount} failed)`}
                </span>
              ) : (
                <span className={`text-[10px] ${hasDownloads ? 'text-success' : 'text-warning'}`}>
                  {hasDownloads ? downloadQueue.size : failedDownloadCount}
                </span>
              )}
            </div>
            {sidebarOpen && hasDownloads && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 text-ink-muted hover:text-danger"
                      onClick={cancelAllDownloads}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Cancel all downloads</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>

          {sidebarOpen && (hasDownloads || hasFailedDownloads) && (
            <div className="space-y-1.5 px-1">
              {/* Overall sync progress */}
              {deviceSyncProgress && deviceSyncProgress.total > 0 && (
                <div>
                  {/* C-004: NaN guard on percentage calculation */}
                  {(() => {
                    const rawPct = (deviceSyncProgress.current / deviceSyncProgress.total) * 100
                    const pct = Number.isFinite(rawPct) ? Math.round(rawPct) : 0
                    return (
                      <>
                        <div className="flex justify-between text-[10px] text-ink-muted mb-0.5">
                          <span>Overall</span>
                          <span>{pct}%</span>
                        </div>
                        <div className="h-1.5 bg-surface-sunken rounded-full overflow-hidden">
                          <div
                            className="h-full bg-success transition-all duration-200"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </>
                    )
                  })()}
                  {deviceSyncEta != null && deviceSyncEta > 0 && (
                    <div className="text-[10px] text-ink-muted mt-0.5">~{formatEta(deviceSyncEta)}</div>
                  )}
                  {deviceFileStage && deviceFileDownloading && (
                    <div className="text-[10px] text-ink-muted mt-0.5 truncate" title={deviceFileDownloading}>
                      {STAGE_LABEL[deviceFileStage]} {deviceFileDownloading}
                    </div>
                  )}
                </div>
              )}
              {/* Individual file progress (top 2) */}
              {Array.from(downloadQueue.entries()).slice(0, 2).map(([id, item]) => (
                <div key={id} className="space-y-0.5">
                  <div className="flex justify-between text-[10px]">
                    <span className="text-ink-muted truncate max-w-[140px]" title={item.filename}>
                      {/* DL-03: Preserve date portion of HiDock filenames (e.g. REC_20260225_143012.wav) */}
                      {(() => {
                        const name = item.filename.replace(/\.(hda|wav|mp3|m4a)$/i, '')
                        return name.length > 24 ? `${name.slice(0, 24)}...` : name
                      })()}
                    </span>
                    {/* C-004: NaN guard on individual file progress */}
                    <span className="text-ink-muted">{Number.isFinite(item.progress) ? item.progress : 0}%</span>
                  </div>
                  <div className="h-1 bg-surface-sunken rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary transition-all duration-200"
                      style={{ width: `${Number.isFinite(item.progress) ? item.progress : 0}%` }}
                    />
                  </div>
                </div>
              ))}
              {downloadQueue.size > 2 && (
                <div className="text-[10px] text-ink-muted">+{downloadQueue.size - 2} more in queue</div>
              )}
              {/* DL-15: Retry Failed button for failed downloads outside Device page */}
              {failedDownloadCount > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full h-6 text-[10px] text-warning hover:text-warning"
                  onClick={handleRetryFailed}
                >
                  <RotateCcw className="h-2.5 w-2.5 mr-1" />
                  Retry {failedDownloadCount} Failed
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Transcriptions Section */}
      {hasTranscriptions && (
        <div className="space-y-1">
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-1.5 text-xs text-ink">
              <Sparkles className="h-3 w-3 text-accent-2 animate-pulse" />
              {sidebarOpen ? (
                <span>
                  Transcriptions ({transcriptionStats.processing + transcriptionStats.pending}
                  {transcriptionStats.failed > 0 && `, ${transcriptionStats.failed} failed`})
                </span>
              ) : (
                <span className="text-[10px] text-accent-2">
                  {transcriptionStats.processing + transcriptionStats.pending}
                </span>
              )}
            </div>
            {sidebarOpen && (transcriptionStats.pending + transcriptionStats.processing > 0) && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 text-ink-muted hover:text-danger"
                      onClick={cancelAllTranscriptions}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Cancel all transcriptions</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>

          {/* Aggregate progress bar */}
          {sidebarOpen && (transcriptionStats.processing + transcriptionStats.pending > 0) && (
            <div className="px-1">
              <div className="w-full h-1.5 bg-surface-sunken rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent-2 rounded-full transition-all duration-300"
                  style={{ width: `${transcriptionStats.aggregateProgress}%` }}
                />
              </div>
              <div className="text-[9px] text-ink-muted mt-0.5 text-right">
                {transcriptionStats.aggregateProgress}% overall
              </div>
            </div>
          )}

          {sidebarOpen && (
            <div className="space-y-1 px-1">
              {Array.from(transcriptionQueue.values())
                .filter((item) => item.status !== 'completed')
                .slice(0, 4)
                .map((item) => (
                  <div key={item.id} className="flex items-center gap-1.5 text-[10px]">
                    {item.status === 'processing' && (
                      <RefreshCw className="h-2.5 w-2.5 text-accent-2 animate-spin shrink-0" />
                    )}
                    {item.status === 'pending' && (
                      <div className="h-2.5 w-2.5 rounded-full bg-warning/60 shrink-0" />
                    )}
                    {item.status === 'failed' && (
                      <AlertCircle className="h-2.5 w-2.5 text-danger shrink-0" />
                    )}
                    <span className="text-ink-muted truncate flex-1" title={item.filename}>
                      {item.filename.length > 18 ? `${item.filename.slice(0, 15)}...` : item.filename}
                    </span>
                    {item.status === 'failed' && (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              className="text-ink-muted hover:text-ink"
                              onClick={() => useTranscriptionStore.getState().retry(item.id)}
                            >
                              <RotateCcw className="h-2.5 w-2.5" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>Retry</p>
                            {item.error && <p className="text-xs text-muted-foreground">{item.error}</p>}
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}
                    {(item.status === 'pending' || item.status === 'processing') && (
                      <button
                        className="text-ink-muted hover:text-danger"
                        onClick={() => cancelTranscription(item.recordingId)}
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    )}
                  </div>
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

