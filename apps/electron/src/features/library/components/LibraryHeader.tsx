import { Plus, FolderOpen, Download, Zap, RefreshCw, LayoutGrid, List } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Eyebrow } from '@/components/harbor/Eyebrow'
import { SegmentedToggle } from '@/components/ui/segmented-toggle'

interface LibraryHeaderProps {
  stats: {
    total: number
    deviceOnly: number
    localOnly: number
    unsynced: number
  }
  deviceConnected: boolean
  loading: boolean
  compactView: boolean
  downloadQueueSize: number
  bulkCounts: {
    deviceOnly: number
    needsTranscription: number
  }
  bulkProcessing: boolean
  bulkProgress: { current: number; total: number }
  /** P4: count of failed transcription queue rows (chip only shows when > 0) */
  failedCount: number
  onAddRecording: () => void
  onOpenFolder: () => void
  onBulkDownload: () => void
  onBulkProcess: () => void
  onRefresh: () => void
  onSetCompactView: (compact: boolean) => void
  /** P4: Retry-all failed transcriptions handler */
  onRetryAllFailed: () => void
}

export function LibraryHeader({
  stats,
  deviceConnected,
  loading,
  compactView,
  downloadQueueSize,
  bulkCounts,
  bulkProcessing,
  bulkProgress,
  failedCount,
  onAddRecording,
  onOpenFolder,
  onBulkDownload,
  onBulkProcess,
  onRefresh,
  onSetCompactView,
  onRetryAllFailed
}: LibraryHeaderProps) {
  return (
    <header className="flex flex-wrap items-end gap-4 border-b border-border px-6 pb-3 pt-4">
      {/* Eyebrow + serif title */}
      <div>
        <Eyebrow>Knowledge</Eyebrow>
        <h1 className="font-display text-[1.75rem] font-semibold tracking-[-0.02em] text-ink">Library</h1>
      </div>

      {/* Mono count + status notes */}
      <p className="pb-1 font-mono text-xs text-ink-muted">
        {stats.total} capture{stats.total !== 1 ? 's' : ''}
        {stats.unsynced > 0 && (
          <span className="ml-2 text-warning">({stats.unsynced} on device only)</span>
        )}
        {!deviceConnected && stats.deviceOnly === 0 && (
          <span className="ml-2 text-ink-muted">(device not connected)</span>
        )}
        {failedCount > 0 && (
          <span className="ml-2 text-danger">
            ({failedCount} transcription{failedCount === 1 ? '' : 's'} failed —{' '}
            <button type="button" onClick={onRetryAllFailed} className="underline underline-offset-2 hover:text-danger/80">
              Retry all
            </button>
            )
          </span>
        )}
      </p>

      <div className="flex-1" />

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={onOpenFolder}>
          <FolderOpen className="h-4 w-4 mr-2" />
          Open Folder
        </Button>

        {/* Bulk Download */}
        {bulkCounts.deviceOnly > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={onBulkDownload}
            disabled={downloadQueueSize > 0 || !deviceConnected}
            title={`Download ${bulkCounts.deviceOnly} captures from device`}
          >
            {downloadQueueSize > 0 ? (
              <>
                <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                Syncing...
              </>
            ) : (
              <>
                <Download className="h-4 w-4 mr-2" />
                Download All ({bulkCounts.deviceOnly})
              </>
            )}
          </Button>
        )}

        {/* Bulk Process */}
        {bulkCounts.needsTranscription > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={onBulkProcess}
            disabled={bulkProcessing}
            title={`Queue ${bulkCounts.needsTranscription} captures for transcription`}
          >
            {bulkProcessing ? (
              <>
                <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                {bulkProgress.current}/{bulkProgress.total}
              </>
            ) : (
              <>
                <Zap className="h-4 w-4 mr-2" />
                Process All ({bulkCounts.needsTranscription})
              </>
            )}
          </Button>
        )}

        <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>

        {/* View Toggle */}
        <div data-testid="grid-view-toggle">
          <SegmentedToggle
            size="sm"
            aria-label="View mode"
            value={compactView ? 'list' : 'card'}
            onChange={(v) => onSetCompactView(v === 'list')}
            options={[
              { value: 'card', label: '', icon: <LayoutGrid className="h-4 w-4" />, title: 'Card view' },
              { value: 'list', label: '', icon: <List className="h-4 w-4" />, title: 'List view' }
            ]}
          />
        </div>

        {/* Primary action */}
        <Button size="sm" onClick={onAddRecording} title="Import audio file">
          <Plus className="h-4 w-4 mr-2" />
          Add Capture
        </Button>
      </div>
    </header>
  )
}
