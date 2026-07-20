/**
 * DeviceFileList Component
 * Displays individual files from connected HiDock device with download/delete actions.
 * Supports sortable columns (FL-003) and multi-select batch download (FL-005).
 */

import { useState, useCallback, useMemo, useEffect } from 'react'
import { Download, Trash2, AlertCircle, CheckCircle, HardDrive, Volume2, ChevronUp, ChevronDown, Mic } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { toast } from '@/components/ui/toaster'
import { getHiDockDeviceService } from '@/services/hidock-device'
import { useOperations } from '@/hooks/useOperations'
import { hasDeviceFile, type DeviceOnlyRecording, type BothLocationsRecording } from '@/types/unified-recording'
import { formatBytes, formatDuration } from '@/utils/formatters'
import { useIsDownloading, useDownloadProgress } from '@/store/useAppStore'
import { useUIStore } from '@/store/ui/useUIStore'

type SortColumn = 'filename' | 'size' | 'duration' | 'dateRecorded'
type SortDirection = 'asc' | 'desc'

interface DeviceFileListProps {
  recordings: Array<DeviceOnlyRecording | BothLocationsRecording>
  syncedFilenames: Set<string>
  onRefresh?: () => void
  // B-DEV-002: Callback to refresh the full recordings list after delete/download
  onRecordingsRefresh?: () => void
}

/**
 * C-004: Check if a filename is synced, accounting for .hda->.mp3 and .hda->.wav normalization
 * Exported for testing.
 */
export function isFilenameSynced(filename: string, syncedFilenames: Set<string>): boolean {
  if (syncedFilenames.has(filename)) return true
  const mp3Name = filename.replace(/\.hda$/i, '.mp3')
  if (mp3Name !== filename && syncedFilenames.has(mp3Name)) return true
  const wavName = filename.replace(/\.hda$/i, '.wav')
  if (wavName !== filename && syncedFilenames.has(wavName)) return true
  return false
}

interface DeviceFileRowProps {
  recording: DeviceOnlyRecording | BothLocationsRecording
  downloadErrors: Map<string, string>
  currentlyPlayingId: string | null
  isPlaying: boolean
  selected: boolean
  onToggleSelect: (id: string) => void
  onDownload: (filename: string, fileSize: number) => void
  onDeleteClick: (filename: string) => void
}

function DeviceFileRow({
  recording,
  downloadErrors,
  currentlyPlayingId,
  isPlaying,
  selected,
  onToggleSelect,
  onDownload,
  onDeleteClick,
}: DeviceFileRowProps) {
  const filename = recording.deviceFilename
  const isDownloading = useIsDownloading(recording.id)
  const downloadProgress = useDownloadProgress(recording.id)

  // FL-002: Show "—" for unknown/zero duration instead of "0:00"
  const durationDisplay = (!recording.duration || recording.duration === 0)
    ? '—'
    : formatDuration(recording.duration)

  const hasError = downloadErrors.has(recording.id) && !isDownloading
  const isCurrentlyPlaying = currentlyPlayingId === recording.id && isPlaying
  const showDownloadButton = recording.location === 'device-only' && !isDownloading

  return (
    <div className={`grid items-center gap-2 px-[var(--space-4)] py-2.5 border-b border-border last:border-0 transition-colors ${selected ? 'bg-accent-strong-soft' : 'hover:bg-surface-hover'}`}
      style={{ gridTemplateColumns: '2rem 1fr 6rem 6rem 9rem 7rem' }}>

      {/* Checkbox */}
      <input
        type="checkbox"
        checked={selected}
        onChange={() => onToggleSelect(recording.id)}
        aria-label={`Select ${filename}`}
        className="h-4 w-4 rounded border-border-strong accent-[var(--primary)]"
      />

      {/* Filename + badges */}
      <div className="min-w-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <Mic className="h-[15px] w-[15px] shrink-0 text-accent-2" />
          <p className="text-[13px] text-ink truncate">{filename}</p>
        </div>
        <div className="flex items-center gap-1.5 mt-1 pl-[25px]">
          {isDownloading ? (
            <Badge variant="warning" size="sm" className="gap-1">
              <Download className="h-3 w-3" />
              {downloadProgress ?? 0}%
            </Badge>
          ) : (
            recording.location === 'device-only' ? (
              <Badge variant="default" size="sm" className="gap-1">
                <HardDrive className="h-3 w-3" />
                On Device
              </Badge>
            ) : recording.location === 'both' ? (
              <Badge variant="primary" size="sm" className="gap-1">
                <CheckCircle className="h-3 w-3" />
                Downloaded
              </Badge>
            ) : (
              <Badge variant="success" size="sm" className="gap-1">
                <CheckCircle className="h-3 w-3" />
                Synced
              </Badge>
            )
          )}
          {hasError && (
            <Badge variant="danger" size="sm" className="gap-1">
              <AlertCircle className="h-3 w-3" />
              Error
            </Badge>
          )}
          {isCurrentlyPlaying && (
            <Badge variant="accent" size="sm" className="gap-1">
              <Volume2 className="h-3 w-3" />
              Playing
            </Badge>
          )}
        </div>
      </div>

      {/* Size */}
      <span className="font-mono text-xs text-foreground">{formatBytes(recording.size)}</span>

      {/* Duration */}
      <span className="font-mono text-xs text-foreground">{durationDisplay}</span>

      {/* Date */}
      <span className="font-mono text-xs text-ink-muted">{recording.dateRecorded?.toLocaleDateString()}</span>

      {/* Actions */}
      <div className="flex items-center gap-1 justify-end">
        {showDownloadButton && (
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs"
            onClick={() => onDownload(filename, recording.size)}>
            <Download className="h-3 w-3 mr-1" />
            DL
          </Button>
        )}
        <Button size="sm" variant="outline" className="h-7 w-7 p-0"
          onClick={() => onDeleteClick(filename)}
          title="Delete from device">
          <Trash2 className="h-3 w-3 text-danger" />
        </Button>
      </div>
    </div>
  )
}

export function DeviceFileList({ recordings, onRefresh, onRecordingsRefresh }: DeviceFileListProps) {
  const deviceService = getHiDockDeviceService()
  // Hosted mode: downloads must stream to the server via the device-sync client, NOT the
  // desktop `downloadRecordingToFile` IPC path (which buffers the whole file and does
  // `Array.from(combined)` — a 150 MB recording becomes a 150-million-element boxed array and
  // throws "Invalid array length"). syncDeviceFiles streams straight to /api/recordings/sync.
  const { syncDeviceFiles } = useOperations()
  const [downloadErrors, setDownloadErrors] = useState<Map<string, string>>(new Map())
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [fileToDelete, setFileToDelete] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  // FL-003: Sort state
  const [sortColumn, setSortColumn] = useState<SortColumn>('dateRecorded')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')

  // FL-005: Selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const currentlyPlayingId = useUIStore((s) => s.currentlyPlayingId)
  const isPlaying = useUIStore((s) => s.isPlaying)

  // Filter to only show device-accessible recordings
  const deviceRecordings = recordings.filter(rec => hasDeviceFile(rec))

  // FL-003: Apply sort
  const sortedRecordings = useMemo(() => {
    const copy = [...deviceRecordings]
    copy.sort((a, b) => {
      let cmp = 0
      if (sortColumn === 'filename') {
        cmp = a.filename.localeCompare(b.filename)
      } else if (sortColumn === 'size') {
        cmp = a.size - b.size
      } else if (sortColumn === 'duration') {
        cmp = (a.duration ?? 0) - (b.duration ?? 0)
      } else {
        cmp = (a.dateRecorded?.getTime() ?? 0) - (b.dateRecorded?.getTime() ?? 0)
      }
      return sortDirection === 'asc' ? cmp : -cmp
    })
    return copy
  }, [deviceRecordings, sortColumn, sortDirection])

  // FL-005: Clear selection on new scan
  useEffect(() => {
    setSelectedIds(new Set())
  }, [recordings])

  const handleSortClick = useCallback((col: SortColumn) => {
    setSortColumn(prev => {
      if (prev === col) {
        setSortDirection(d => d === 'asc' ? 'desc' : 'asc')
        return col
      }
      // New column: date defaults to desc, others to asc
      setSortDirection(col === 'dateRecorded' ? 'desc' : 'asc')
      return col
    })
  }, [])

  const toggleSelection = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleSelectAll = useCallback(() => {
    if (selectedIds.size === sortedRecordings.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(sortedRecordings.map(r => r.id)))
    }
  }, [selectedIds.size, sortedRecordings])

  // Handle individual file download
  const handleDownloadFile = useCallback(async (filename: string, fileSize: number) => {
    const recordingId = deviceRecordings.find(r => r.deviceFilename === filename)?.id
    if (recordingId) {
      setDownloadErrors(prev => { const m = new Map(prev); m.delete(recordingId); return m })
    }
    try {
      const synced = await syncDeviceFiles([{ filename, size: fileSize }])
      if (synced > 0) {
        toast.success(`Downloaded ${filename}`)
        onRefresh?.()
        onRecordingsRefresh?.()
      } else {
        toast.error(`Failed to download ${filename}`)
        if (recordingId) setDownloadErrors(prev => new Map(prev).set(recordingId, 'Download failed'))
      }
    } catch (error: any) {
      console.error('[DeviceFileList] Download error:', error)
      toast.error(error?.message || `Failed to download ${filename}`)
      if (recordingId) setDownloadErrors(prev => new Map(prev).set(recordingId, error?.message || 'Download failed'))
    }
  }, [syncDeviceFiles, deviceRecordings, onRefresh, onRecordingsRefresh])

  const handleDeleteClick = useCallback((filename: string) => {
    setFileToDelete(filename)
    setDeleteDialogOpen(true)
  }, [])

  const handleConfirmDelete = useCallback(async () => {
    if (!fileToDelete) return
    setDeleting(true)
    try {
      const success = await deviceService.deleteRecording(fileToDelete)
      if (success) {
        toast.success(`Deleted ${fileToDelete} from device`)
        onRefresh?.()
        onRecordingsRefresh?.()
      } else {
        toast.error(`Failed to delete ${fileToDelete}`)
      }
    } catch (error: any) {
      console.error('[DeviceFileList] Delete error:', error)
      toast.error(error?.message || `Failed to delete ${fileToDelete}`)
    } finally {
      setDeleting(false)
      setDeleteDialogOpen(false)
      setFileToDelete(null)
    }
  }, [fileToDelete, deviceService, onRefresh, onRecordingsRefresh])

  if (deviceRecordings.length === 0) return null

  const recordingToDelete = deviceRecordings.find(r => r.deviceFilename === fileToDelete)
  const hasLocalCopy = recordingToDelete?.location === 'both'

  // FL-005: Batch download
  const selectedUndownloaded = sortedRecordings.filter(
    r => selectedIds.has(r.id) && r.location === 'device-only'
  )
  const allSelectedSynced = selectedIds.size > 0 && selectedUndownloaded.length === 0

  const SortIcon = ({ col }: { col: SortColumn }) => {
    if (sortColumn !== col) return null
    return sortDirection === 'asc'
      ? <ChevronUp className="h-3 w-3 inline ml-0.5" />
      : <ChevronDown className="h-3 w-3 inline ml-0.5" />
  }

  const headerCell = (col: SortColumn, label: string) => (
    <button
      onClick={() => handleSortClick(col)}
      className="flex items-center gap-0.5 font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-muted font-medium cursor-pointer select-none hover:text-ink transition-colors"
    >
      {label}<SortIcon col={col} />
    </button>
  )

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <div>
              <CardTitle>Device Files ({deviceRecordings.length})</CardTitle>
              <CardDescription>
                {selectedIds.size > 0
                  ? `${selectedIds.size} of ${sortedRecordings.length} selected`
                  : 'Manage individual recordings on your HiDock device'}
              </CardDescription>
            </div>
            {selectedIds.size > 0 && (
              <Button
                size="sm"
                variant="default"
                disabled={allSelectedSynced}
                onClick={async () => {
                  // Serialize the batch through ONE guarded syncDeviceFiles call (holds the
                  // download guard for the whole batch) instead of an un-awaited forEach that
                  // fired every download concurrently and let refreshes cancel their reads.
                  const files = selectedUndownloaded.map((r) => ({ filename: r.deviceFilename, size: r.size }))
                  if (files.length === 0) return
                  try {
                    const synced = await syncDeviceFiles(files)
                    if (synced > 0) {
                      toast.success(`Downloaded ${synced} file${synced !== 1 ? 's' : ''}`)
                      onRefresh?.()
                      onRecordingsRefresh?.()
                    } else {
                      toast.error('No files downloaded')
                    }
                  } catch (error: any) {
                    toast.error(error?.message || 'Download failed')
                  }
                }}
              >
                <Download className="h-4 w-4 mr-1" />
                {allSelectedSynced
                  ? 'All selected synced'
                  : `Download ${selectedUndownloaded.length} file${selectedUndownloaded.length !== 1 ? 's' : ''}`}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {/* Sticky column header */}
          <div className="grid items-center gap-2 px-[var(--space-4)] py-2.5 border-b border-border bg-surface-sunken sticky top-0 z-10"
            style={{ gridTemplateColumns: '2rem 1fr 6rem 6rem 9rem 7rem' }}>
            <input
              type="checkbox"
              checked={sortedRecordings.length > 0 && selectedIds.size === sortedRecordings.length}
              ref={el => { if (el) el.indeterminate = selectedIds.size > 0 && selectedIds.size < sortedRecordings.length }}
              onChange={handleSelectAll}
              aria-label="Select all recordings"
              className="h-4 w-4 rounded border-border-strong accent-[var(--primary)]"
            />
            {headerCell('filename', 'Name')}
            {headerCell('size', 'Size')}
            {headerCell('duration', 'Duration')}
            {headerCell('dateRecorded', 'Date')}
            <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-muted font-medium">Actions</span>
          </div>

          {/* Scrollable rows */}
          <div className="max-h-[360px] overflow-y-auto">
            {sortedRecordings.map(recording => (
              <DeviceFileRow
                key={recording.deviceFilename}
                recording={recording}
                downloadErrors={downloadErrors}
                currentlyPlayingId={currentlyPlayingId}
                isPlaying={isPlaying}
                selected={selectedIds.has(recording.id)}
                onToggleSelect={toggleSelection}
                onDownload={handleDownloadFile}
                onDeleteClick={handleDeleteClick}
              />
            ))}
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-destructive" />
              Delete File from Device?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>{fileToDelete}</strong> from your HiDock device?
              <br /><br />
              <span className="text-destructive font-medium">
                This action cannot be undone. The file will be permanently removed from the device.
              </span>
              {hasLocalCopy && (
                <span className="block mt-2 text-success">
                  Note: A local copy exists in your library.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleConfirmDelete() }}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? 'Deleting...' : 'Delete File'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
