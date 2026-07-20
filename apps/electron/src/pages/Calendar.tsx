import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Mic, RefreshCw, Play, X, LayoutGrid, Square, CheckSquare, FileText, Trash2, List, FileAudio, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn, formatTime, isToday, formatDuration } from '@/lib/utils'
import {
  useAppStore,
  useMeetings,
  useMeetingsLoading,
  useCurrentDate,
  useCalendarView,
  useLastCalendarSync,
  useCalendarSyncing,
  useDownloadQueue,
  useDeviceSyncing,
  useSetLastCalendarSync,
  useSetCalendarSyncing,
} from '@/store/useAppStore'
import { useConfigStore } from '@/store/domain/useConfigStore'
import type { Meeting, Recording } from '@/types'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { RecordingLinkDialog } from '@/components/RecordingLinkDialog'
import { useUnifiedRecordings } from '@/hooks/useUnifiedRecordings'
import { useToday } from '@/hooks/useToday'
import { UnifiedRecording, hasLocalPath, isDeviceOnly, hasDeviceFile } from '@/types/unified-recording'
import { getHiDockDeviceService } from '@/services/hidock-device'
import { AudioPlayer } from '@/components/AudioPlayer'
import { useAudioControls } from '@/components/OperationController'
import { useUIStore } from '@/store/useUIStore'
import { useOperations } from '@/hooks/useOperations'
import { toast } from '@/components/ui/toaster'

// Extracted calendar components
import { CalendarHeader, CalendarStatsBar, StatusIcon, RecordingTooltipContent, MeetingOverlayTooltipContent } from '@/components/calendar'
import type { LocationFilter, SortOption } from '@/components/calendar'

// Extracted calendar utilities
import {
  type CalendarViewType,
  type CalendarRecording,
  type CalendarMeetingOverlay,
  HOUR_HEIGHT,
  DEFAULT_START_HOUR,
  DEFAULT_END_HOUR,
  getWeekDates,
  getWorkweekDates,
  getDayDates,
  getMonthDates,
  matchRecordingsToMeetings,
  createPlaceholderMeetings,
  buildCalendarRecordings,
  formatDurationStr,
  groupByDay,
  computeVisibleHourRange,
} from '@/lib/calendar-utils'

// Helper functions for date/time formatting in list views
function formatShortDate(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function formatShortTime(date: Date): string {
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

// CA-05: Current time indicator that updates every 60 seconds
function CurrentTimeIndicator({ startHour, hourHeight }: { startHour: number; hourHeight: number }) {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const interval = setInterval(() => {
      setNow(new Date())
    }, 60000)
    return () => clearInterval(interval)
  }, [])

  const top = Math.max(0, (now.getHours() + now.getMinutes() / 60 - startHour) * hourHeight)

  return (
    <div
      className="pointer-events-none absolute left-0 right-0 z-20 border-t-2 border-[var(--coral-600)]"
      style={{ top }}
    >
      <div className="absolute -left-1.5 -top-1.5 h-3 w-3 rounded-full bg-[var(--coral-600)]" />
    </div>
  )
}

export function Calendar() {
  const navigate = useNavigate()
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  // Use useToday hook to ensure "today" updates at midnight
  // The return value triggers re-render; isToday() from utils uses fresh Date()
  const _today = useToday()
  void _today
  // SM-04 fix: Use granular selectors instead of destructuring 8+ fields
  const meetings = useMeetings()
  const currentDate = useCurrentDate()
  const meetingsLoading = useMeetingsLoading()
  const calendarView = useCalendarView()
  const lastSync = useLastCalendarSync()
  const calendarSyncing = useCalendarSyncing()
  const downloadQueue = useDownloadQueue()
  // Action selectors - still need direct access
  const navigateWeek = useAppStore((s) => s.navigateWeek)
  const navigateMonth = useAppStore((s) => s.navigateMonth)
  const goToToday = useAppStore((s) => s.goToToday)
  const setCurrentDate = useAppStore((s) => s.setCurrentDate)
  const setCalendarView = useAppStore((s) => s.setCalendarView)
  const loadMeetings = useAppStore((s) => s.loadMeetings)
  // B-CAL-005: Granular config selectors to prevent excess re-renders
  const calendarConfig = useConfigStore((s) => s.config?.calendar)
  const uiConfig = useConfigStore((s) => s.config?.ui)
  const loadConfig = useConfigStore((s) => s.loadConfig)
  const updateConfig = useConfigStore((s) => s.updateConfig)
  // B-CAL-001: Named action selectors replace raw useAppStore.setState()
  const setLastCalendarSync = useSetLastCalendarSync()
  const setCalendarSyncing = useSetCalendarSyncing()

  // Get unified recordings (device + local)
  const { recordings: unifiedRecordings, loading: recordingsLoading, refresh: refreshRecordings, deviceConnected, stats } = useUnifiedRecordings()

  // Centralized operations
  const { queueTranscription, queueDownload, queueBulkDownloads } = useOperations()

  // Device sync guard: block starting a new download while any single/batch sync
  // is in flight (shared USB read loop — see fix/hosted-device-downloads).
  const deviceSyncing = useDeviceSyncing()

  // State from config (with defaults)
  // calendarView now comes from useAppStore (single source of truth — CA-04)
  const [hideEmptyMeetings, setHideEmptyMeetings] = useState(true)
  const [showListView, setShowListView] = useState(false)
  const [autoSyncEnabled, setAutoSyncEnabled] = useState(true)

  // Playback state from global store
  const currentlyPlayingId = useUIStore((state) => state.currentlyPlayingId)
  const audioControls = useAudioControls()
  // Note: downloadingIds now comes from global downloadQueue store

  // Filter and sort state (types imported from @/components/calendar)
  type ViewMode = 'list' | 'compact' | 'cards'
  const [locationFilter, setLocationFilter] = useState<LocationFilter>('all')
  const [sortBy, setSortBy] = useState<SortOption>('date-desc')
  const [viewMode, setViewMode] = useState<ViewMode>('compact')

  // Selection state for bulk actions
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkDownloading, setBulkDownloading] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [transcribing, setTranscribing] = useState<string | null>(null)

  // State for recording link dialog
  const [linkDialogRecording, setLinkDialogRecording] = useState<
    Pick<Recording, 'id' | 'filename' | 'date_recorded' | 'duration_seconds'> | null
  >(null)

  // Load config on mount - must complete BEFORE first sync
  useEffect(() => {
    const initialize = async () => {
      try {
        // Load config FIRST
        await loadConfig()
      } catch (error) {
        console.error('[Calendar] Failed to load config on mount:', error)
      }
    }
    initialize()
  }, [loadConfig])

  // Sync state with config when it loads
  // B-CAL-005: Depends on granular uiConfig/calendarConfig instead of whole config object
  useEffect(() => {
    if (uiConfig) {
      setCalendarView(uiConfig.calendarView || 'week')
      setHideEmptyMeetings(uiConfig.hideEmptyMeetings ?? true)
      setShowListView(uiConfig.showListView ?? false)
    }
    if (calendarConfig) {
      setAutoSyncEnabled(calendarConfig.syncEnabled)
      // CA-03 FIX: Load lastSyncAt from config on mount
      // B-CAL-001: Use named action instead of raw setState
      if (calendarConfig.lastSyncAt) {
        setLastCalendarSync(calendarConfig.lastSyncAt)
      }
    }
  }, [uiConfig, calendarConfig, setCalendarView, setLastCalendarSync])

  // Load meetings when date or view changes
  useEffect(() => {
    let startDate: string
    let endDate: string

    if (calendarView === 'month') {
      const dates = getMonthDates(currentDate)
      startDate = dates[0].toISOString()
      const lastDate = new Date(dates[dates.length - 1])
      lastDate.setHours(23, 59, 59, 999)
      endDate = lastDate.toISOString()
    } else if (calendarView === 'day') {
      const dayStart = new Date(currentDate)
      dayStart.setHours(0, 0, 0, 0)
      const dayEnd = new Date(currentDate)
      dayEnd.setHours(23, 59, 59, 999)
      startDate = dayStart.toISOString()
      endDate = dayEnd.toISOString()
    } else if (calendarView === 'workweek') {
      const dates = getWorkweekDates(currentDate)
      startDate = dates[0].toISOString()
      const lastDate = new Date(dates[dates.length - 1])
      lastDate.setHours(23, 59, 59, 999)
      endDate = lastDate.toISOString()
    } else {
      const dates = getWeekDates(currentDate)
      startDate = dates[0].toISOString()
      const lastDate = new Date(dates[6])
      lastDate.setHours(23, 59, 59, 999)
      endDate = lastDate.toISOString()
    }

    loadMeetings(startDate, endDate)
  }, [currentDate, calendarView, loadMeetings])

  // Get dates for current view
  const viewDates = useMemo((): Date[] => {
    switch (calendarView) {
      case 'day':
        return getDayDates(currentDate)
      case 'workweek':
        return getWorkweekDates(currentDate)
      case 'week':
        return getWeekDates(currentDate)
      case 'month':
        return getMonthDates(currentDate)
      default:
        return getWeekDates(currentDate)
    }
  }, [currentDate, calendarView])

  const monthDates = useMemo(() => getMonthDates(currentDate), [currentDate])

  // Office hours from config (B-CAL-005: uses granular uiConfig)
  const officeHoursStart = uiConfig?.officeHoursStart ?? 9
  const officeHoursEnd = uiConfig?.officeHoursEnd ?? 18
  const workDays = uiConfig?.workDays ?? [1, 2, 3, 4, 5]

  // Check if a date is a work day
  const isWorkDay = (date: Date) => workDays.includes(date.getDay())

  // Check if an hour is within office hours
  const isOfficeHour = (hour: number) => hour >= officeHoursStart && hour < officeHoursEnd

  // Match recordings to meetings and create placeholders for orphan recordings
  const { calendarMeetings, orphanRecordings } = useMemo(() => {
    return matchRecordingsToMeetings(meetings, unifiedRecordings)
  }, [meetings, unifiedRecordings])

  // Create placeholder meetings from orphan recordings
  const placeholderMeetings = useMemo(() => {
    return createPlaceholderMeetings(orphanRecordings)
  }, [orphanRecordings])

  // Combine real meetings with placeholders (based on toggle)
  // C-CAL-005: Deduplicate meetings by ID to prevent duplicate entries from
  // calendar sync providing overlapping data.
  const allMeetings = useMemo(() => {
    let combined: typeof calendarMeetings
    if (hideEmptyMeetings) {
      // Only show meetings that have recordings + orphan recordings as placeholders
      const meetingsWithRecordings = calendarMeetings.filter(m => m.hasRecording)
      combined = [...meetingsWithRecordings, ...placeholderMeetings]
    } else {
      // Show all calendar meetings (with and without recordings) + orphan recordings as placeholders
      combined = [...calendarMeetings, ...placeholderMeetings]
    }
    // Deduplicate by meeting ID (keep the first occurrence, which is the real meeting if both exist)
    const seen = new Set<string>()
    return combined.filter(m => {
      if (seen.has(m.id)) return false
      seen.add(m.id)
      return true
    })
  }, [calendarMeetings, placeholderMeetings, hideEmptyMeetings])

  // Group meetings by day (for day/workweek/week views)
  const meetingsByDay = useMemo(() => {
    const grouped = groupByDay(
      allMeetings,
      (m) => new Date(m.start_time),
      viewDates
    )
    // Sort meetings by start time within each day
    for (const key in grouped) {
      grouped[key].sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())
    }
    return grouped
  }, [allMeetings, viewDates])

  // Group meetings for month view
  const meetingsByMonth = useMemo(() => {
    const grouped = groupByDay(
      allMeetings,
      (m) => new Date(m.start_time),
      monthDates
    )
    // Sort meetings by start time within each day
    for (const key in grouped) {
      grouped[key].sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())
    }
    return grouped
  }, [allMeetings, monthDates])

  // ===== RECORDING-CENTRIC DATA =====
  // Build recording-centric calendar data (recordings as PRIMARY, meetings as metadata)
  const { calendarRecordings, meetingOverlays } = useMemo(() => {
    return buildCalendarRecordings(unifiedRecordings, meetings)
  }, [unifiedRecordings, meetings])

  // B-CAL-003: Compute dynamic visible hour range based on actual events
  const { startHour: visibleStartHour, endHour: visibleEndHour, hours: visibleHours } = useMemo(() => {
    return computeVisibleHourRange(calendarRecordings, meetingOverlays, DEFAULT_START_HOUR, DEFAULT_END_HOUR)
  }, [calendarRecordings, meetingOverlays])

  // C-CAL-001/C-CAL-002: Scroll to current hour only on initial mount or when switching
  // FROM list view TO calendar view (not on every showListView toggle).
  // Uses a ref to track whether we've already scrolled for the current calendar session.
  // Placed after visibleStartHour computation to avoid TDZ reference error.
  const hasScrolledRef = useRef(false)
  useEffect(() => {
    if (showListView) {
      // Reset scroll tracking when switching to list view,
      // so switching back to calendar will scroll again.
      hasScrolledRef.current = false
      return
    }
    if (scrollContainerRef.current && !hasScrolledRef.current) {
      const now = new Date()
      const currentHour = now.getHours()
      const scrollPosition = Math.max(0, (currentHour - visibleStartHour - 1) * HOUR_HEIGHT)
      scrollContainerRef.current.scrollTop = scrollPosition
      hasScrolledRef.current = true
    }
  }, [showListView, visibleStartHour])

  // Group recordings by day (for day/workweek/week views)
  const recordingsByDay = useMemo(() => {
    const grouped = groupByDay(
      calendarRecordings,
      (r) => r.startTime,
      viewDates
    )
    // Sort recordings by start time within each day
    for (const key in grouped) {
      grouped[key].sort((a, b) => a.startTime.getTime() - b.startTime.getTime())
    }
    return grouped
  }, [calendarRecordings, viewDates])

  // Group meeting overlays by day (only meetings WITHOUT recordings, shown as dashed)
  const meetingOverlaysByDay = useMemo(() => {
    // Only include meetings that have NO recordings (they are shown as dashed overlays)
    const meetingsWithoutRecordings = hideEmptyMeetings ? [] : meetingOverlays.filter(m => !m.hasRecording)
    const grouped = groupByDay(
      meetingsWithoutRecordings,
      (m) => m.startTime,
      viewDates
    )
    // Sort by start time within each day
    for (const key in grouped) {
      grouped[key].sort((a, b) => a.startTime.getTime() - b.startTime.getTime())
    }
    return grouped
  }, [meetingOverlays, viewDates, hideEmptyMeetings])

  const handleMeetingClick = (meeting: Meeting) => {
    navigate(`/meeting/${meeting.id}`)
  }

  // Handle recording click - navigate to recording details or open link dialog
  const handleRecordingClick = (recording: CalendarRecording) => {
    if (recording.linkedMeeting) {
      navigate(`/meeting/${recording.linkedMeeting.id}`)
    } else {
      // Open link dialog for orphan recordings
      setLinkDialogRecording({
        id: recording.id,
        filename: recording.filename,
        date_recorded: recording.startTime.toISOString(),
        duration_seconds: recording.durationSeconds
      })
    }
  }

  // Calculate recording position and height (RECORDING-CENTRIC)
  // B-CAL-003: Uses dynamic visibleStartHour instead of static START_HOUR
  const getRecordingStyle = (recording: CalendarRecording) => {
    const startHour = recording.startTime.getHours() + recording.startTime.getMinutes() / 60
    const endHour = recording.endTime.getHours() + recording.endTime.getMinutes() / 60

    const top = Math.max(0, (startHour - visibleStartHour) * HOUR_HEIGHT)
    const height = Math.max(20, (endHour - startHour) * HOUR_HEIGHT - 2)

    return { top, height }
  }

  // Calculate meeting overlay position (for dashed meeting blocks)
  // B-CAL-003: Uses dynamic visibleStartHour instead of static START_HOUR
  const getMeetingOverlayStyle = (meeting: CalendarMeetingOverlay) => {
    const startHour = meeting.startTime.getHours() + meeting.startTime.getMinutes() / 60
    const endHour = meeting.endTime.getHours() + meeting.endTime.getMinutes() / 60

    const top = Math.max(0, (startHour - visibleStartHour) * HOUR_HEIGHT)
    const height = Math.max(20, (endHour - startHour) * HOUR_HEIGHT - 2)

    return { top, height }
  }

  const monthYear = currentDate instanceof Date 
    ? currentDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    : ''

  // Format last sync time (memoized)
  const formatLastSync = useCallback(() => {
    if (!lastSync) return ''
    const syncDate = new Date(lastSync)
    return syncDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  }, [lastSync])

  // Handle sync button click
  // B-CAL-001: Uses named store actions instead of raw useAppStore.setState()

  const handleSync = useCallback(async () => {
    console.log('[Calendar] Clearing cache and resyncing...')
    setCalendarSyncing(true)
    try {
      const result = await window.electronAPI.calendar.clearAndSync()
      console.log('[Calendar] Clear and sync result:', result)
      if (result && !result.success) {
        toast.error('Calendar sync failed', result.error || 'Unknown error occurred')
      } else if (result && result.success) {
        // CA-03 FIX: Update lastSync state after successful sync
        // CS-002: Always update — don't guard on result.lastSync which may be absent
        setLastCalendarSync(result.lastSync ?? new Date().toISOString())
        toast.success(`Calendar synced successfully: ${result.meetingsCount || 0} meetings`)
      }
      // Reload meetings for current view
      // CA-08 FIX: Guard against empty viewDates array
      if (!viewDates || viewDates.length === 0) {
        console.warn('[Calendar] No view dates available, skipping meeting reload')
        return
      }
      const endDate = new Date(viewDates[viewDates.length - 1])
      endDate.setHours(23, 59, 59, 999)
      await loadMeetings(viewDates[0].toISOString(), endDate.toISOString())
    } catch (err) {
      console.error('[Calendar] Clear and sync failed:', err)
      // CA-07 FIX: Already showing error to user via toast
      toast.error('Calendar sync failed', err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setCalendarSyncing(false)
    }
  }, [viewDates, loadMeetings, setCalendarSyncing, setLastCalendarSync])

  // Handle navigation (memoized)
  const handleNavigatePrev = useCallback(() => {
    if (calendarView === 'day') {
      const newDate = new Date(currentDate)
      newDate.setDate(newDate.getDate() - 1)
      setCurrentDate(newDate)
    } else if (calendarView === 'month') {
      navigateMonth('prev')
    } else {
      navigateWeek('prev')
    }
  }, [calendarView, navigateMonth, navigateWeek, currentDate, setCurrentDate])

  const handleNavigateNext = useCallback(() => {
    if (calendarView === 'day') {
      const newDate = new Date(currentDate)
      newDate.setDate(newDate.getDate() + 1)
      setCurrentDate(newDate)
    } else if (calendarView === 'month') {
      navigateMonth('next')
    } else {
      navigateWeek('next')
    }
  }, [calendarView, navigateMonth, navigateWeek, currentDate, setCurrentDate])

  // Handle view changes with config persistence (memoized)
  const handleCalendarViewChange = useCallback(async (view: CalendarViewType) => {
    setCalendarView(view)
    try {
      await updateConfig('ui', { calendarView: view })
    } catch (e) {
      console.error('Failed to save view preference:', e)
    }
  }, [setCalendarView, updateConfig])

  const handleHideEmptyToggle = useCallback(async (hide: boolean) => {
    setHideEmptyMeetings(hide)
    try {
      await updateConfig('ui', { hideEmptyMeetings: hide })
    } catch (e) {
      console.error('Failed to save preference:', e)
    }
  }, [updateConfig])

  const handleViewToggle = useCallback(async (listView: boolean) => {
    setShowListView(listView)
    try {
      await updateConfig('ui', { showListView: listView })
    } catch (e) {
      console.error('Failed to save preference:', e)
    }
  }, [updateConfig])

  const handleAutoSyncToggle = useCallback(async (enabled: boolean) => {
    setAutoSyncEnabled(enabled)
    try {
      await window.electronAPI.calendar.toggleAutoSync(enabled)
      try {
        await loadConfig()
      } catch (configError) {
        console.error('Failed to reload config after auto-sync toggle:', configError)
        // Config reload failure is non-critical; the toggle already succeeded
      }
    } catch (error) {
      console.error('Failed to toggle auto-sync:', error)
      setAutoSyncEnabled(!enabled)
    }
  }, [loadConfig])

  // Download recording from device via centralized useOperations
  const handleDownload = useCallback(async (recording: UnifiedRecording) => {
    await queueDownload(recording)
  }, [queueDownload])

  // Delete recording from device (memoized)
  const handleDeleteFromDevice = useCallback(async (recording: UnifiedRecording) => {
    if (!hasDeviceFile(recording)) return

    const deviceService = getHiDockDeviceService()
    if (!deviceService.isConnected()) return

    // Confirm deletion
    const confirmed = window.confirm(`Delete "${recording.filename}" from device? This cannot be undone.`)
    if (!confirmed) return

    setDeleting(recording.id)
    try {
      await deviceService.deleteRecording(recording.deviceFilename)
      await refreshRecordings(true)
    } catch (e) {
      console.error('Delete failed:', e)
    } finally {
      setDeleting(null)
    }
  }, [refreshRecordings])

  // Delete local recording (memoized)
  const handleDeleteLocal = useCallback(async (recording: UnifiedRecording) => {
    if (!hasLocalPath(recording)) return

    const confirmed = window.confirm(`Delete "${recording.filename}" from local storage? This cannot be undone.`)
    if (!confirmed) return

    setDeleting(recording.id)
    try {
      await window.electronAPI.recordings.delete(recording.id)
      await refreshRecordings(false)
    } catch (e) {
      console.error('Delete failed:', e)
    } finally {
      setDeleting(null)
    }
  }, [refreshRecordings])

  // Trigger transcription for a local recording (memoized)
  const handleTranscribe = useCallback(async (recording: UnifiedRecording) => {
    setTranscribing(recording.id)
    try {
      const queued = await queueTranscription(recording)
      if (queued) {
        await refreshRecordings(false)
      }
    } finally {
      setTranscribing(null)
    }
  }, [queueTranscription, refreshRecordings])

  // Selection handlers (memoized)
  const toggleSelection = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
  }, [])

  // For list view, apply filters and sorting
  const filteredRecordings = useMemo(() => {
    let filtered = [...unifiedRecordings]

    // Apply location filter
    if (locationFilter !== 'all') {
      filtered = filtered.filter(r => r.location === locationFilter)
    }

    // Apply sorting
    filtered.sort((a, b) => {
      switch (sortBy) {
        case 'date-desc':
          return b.dateRecorded.getTime() - a.dateRecorded.getTime()
        case 'date-asc':
          return a.dateRecorded.getTime() - b.dateRecorded.getTime()
        case 'name-asc':
          return a.filename.localeCompare(b.filename)
        case 'name-desc':
          return b.filename.localeCompare(a.filename)
        case 'size-desc':
          return (b.size || 0) - (a.size || 0)
        default:
          return 0
      }
    })

    return filtered
  }, [unifiedRecordings, locationFilter, sortBy])

  // SelectAll and bulk handlers need filteredRecordings, defined after useMemo
  const selectAll = useCallback(() => {
    setSelectedIds(new Set(filteredRecordings.map(r => r.id)))
  }, [filteredRecordings])

  // Bulk download selected device-only recordings via centralized useOperations
  const handleBulkDownload = useCallback(async () => {
    const selected = filteredRecordings.filter((r) => selectedIds.has(r.id))
    if (selected.length === 0) return

    setBulkDownloading(true)
    await queueBulkDownloads(selected)
    setBulkDownloading(false)
    clearSelection()
  }, [filteredRecordings, selectedIds, queueBulkDownloads, clearSelection])

  // Location filter handler (memoized)
  const handleLocationFilterChange = useCallback((filter: LocationFilter) => {
    setLocationFilter(filter)
  }, [])

  // Sort handler (memoized)
  const handleSortChange = useCallback((sort: SortOption) => {
    setSortBy(sort)
  }, [])

  return (
    <TooltipProvider delayDuration={300}>
    <div className="flex flex-col h-full">
      {/* Header - using extracted component */}
      <CalendarHeader
        title={showListView ? 'Recordings' : monthYear}
        showListView={showListView}
        calendarView={calendarView}
        calendarSyncing={calendarSyncing}
        lastSync={lastSync}
        autoSyncEnabled={autoSyncEnabled}
        hideEmptyMeetings={hideEmptyMeetings}
        syncIntervalMinutes={calendarConfig?.syncIntervalMinutes}
        formatLastSync={formatLastSync}
        onNavigatePrev={handleNavigatePrev}
        onNavigateNext={handleNavigateNext}
        onGoToToday={goToToday}
        onSync={handleSync}
        onAutoSyncToggle={handleAutoSyncToggle}
        onHideEmptyToggle={handleHideEmptyToggle}
        onViewToggle={handleViewToggle}
        onCalendarViewChange={handleCalendarViewChange}
      />

      {/* Stats bar - using extracted component */}
      <CalendarStatsBar
        stats={stats}
        locationFilter={locationFilter}
        sortBy={sortBy}
        showListView={showListView}
        deviceConnected={deviceConnected}
        onLocationFilterChange={handleLocationFilterChange}
        onSortChange={handleSortChange}
      />

      {/* Main Content */}
      {(meetingsLoading || recordingsLoading) && meetings.length === 0 && unifiedRecordings.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-ink-muted">Loading...</p>
        </div>
      ) : showListView ? (
        /* C-CAL-003: Show subtle sync indicator when resyncing with existing data */
        <>{calendarSyncing && (
          <div className="flex flex-shrink-0 items-center gap-2 border-b border-border bg-accent-strong-soft px-[var(--space-5)] py-1.5 font-mono text-[11px] text-[var(--accent-soft-text)]">
            <RefreshCw className="h-3 w-3 animate-spin" />
            <span>Syncing calendar...</span>
          </div>
        )}
        /* List/Cards View */
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Bulk Actions Bar */}
          {selectedIds.size > 0 && (
            <div className="flex flex-shrink-0 items-center gap-4 border-b border-border bg-accent-strong-soft px-[var(--space-5)] py-2">
              <span className="text-sm font-medium text-ink">{selectedIds.size} selected</span>
              <Button variant="outline" size="sm" onClick={clearSelection}>Clear</Button>
              <Button
                variant="default"
                size="sm"
                onClick={handleBulkDownload}
                disabled={bulkDownloading || deviceSyncing || !deviceConnected}
              >
                {bulkDownloading ? <RefreshCw className="h-3 w-3 animate-spin mr-2" /> : <Download className="h-3 w-3 mr-2" />}
                Download Selected
              </Button>
            </div>
          )}

          {/* View Mode Toggle */}
          <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-[var(--space-5)] py-2">
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={selectAll} className="h-7 text-xs">
                Select All
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant={viewMode === 'compact' ? 'secondary' : 'ghost'}
                size="icon"
                className="h-7 w-7"
                onClick={() => setViewMode('compact')}
                title="Compact list"
              >
                <List className="h-4 w-4" />
              </Button>
              <Button
                variant={viewMode === 'cards' ? 'secondary' : 'ghost'}
                size="icon"
                className="h-7 w-7"
                onClick={() => setViewMode('cards')}
                title="Card view"
              >
                <LayoutGrid className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-auto p-4">
            {filteredRecordings.length === 0 ? (
              <div className="py-16 text-center">
                <Mic className="mx-auto mb-4 h-12 w-12 text-ink-muted opacity-50" />
                <h3 className="mb-2 font-display text-[1.375rem] font-semibold tracking-[-0.01em] text-ink">No Recordings</h3>
                <p className="text-ink-muted">
                  {locationFilter !== 'all' ? 'No recordings match the current filter.' : 'No recordings found.'}
                </p>
              </div>
            ) : viewMode === 'cards' ? (
              /* Card View - Responsive Grid */
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                {filteredRecordings.map((recording) => {
                  const canPlay = hasLocalPath(recording)
                  const isSelected = selectedIds.has(recording.id)

                  return (
                    <div
                      key={recording.id}
                      onClick={() => toggleSelection(recording.id)}
                      className={cn(
                        'relative cursor-pointer rounded-lg border border-border p-3 transition-all hover:shadow-md',
                        isSelected ? 'ring-2 ring-accent-strong bg-accent-strong-soft' : 'hover:bg-surface-hover'
                      )}
                    >
                      {/* Selection indicator */}
                      <div className="absolute right-2 top-2">
                        {isSelected ? (
                          <CheckSquare className="h-4 w-4 text-accent-strong" />
                        ) : (
                          <Square className="h-4 w-4 text-ink-muted/40" />
                        )}
                      </div>

                      {/* Location icon */}
                      <div className="mb-2">
                        <StatusIcon location={recording.location} />
                      </div>

                      {/* Date */}
                      <div className="text-xs font-medium text-ink">
                        {formatShortDate(recording.dateRecorded)}
                      </div>
                      <div className="text-xs text-ink-muted">
                        {formatShortTime(recording.dateRecorded)}
                      </div>

                      {/* Duration */}
                      {recording.duration > 0 && (
                        <div className="mt-1 text-xs text-ink-muted">
                          {formatDuration(recording.duration)}
                        </div>
                      )}

                      {/* Transcription status */}
                      {recording.transcriptionStatus !== 'none' && (
                        <div className={cn(
                          'mt-2 rounded px-1.5 py-0.5 text-center text-xs',
                          recording.transcriptionStatus === 'complete' && 'bg-success-soft text-success',
                          recording.transcriptionStatus === 'processing' && 'bg-warning-soft text-warning',
                          recording.transcriptionStatus === 'error' && 'bg-danger-soft text-danger'
                        )}>
                          {recording.transcriptionStatus === 'complete' ? <FileText className="h-3 w-3 inline" /> : recording.transcriptionStatus}
                        </div>
                      )}

                      {/* Actions */}
                      <div className="flex gap-1 mt-2" onClick={e => e.stopPropagation()}>
                        {isDeviceOnly(recording) && (
                          <Button variant="ghost" size="icon" className="h-6 w-6"
                            onClick={() => handleDownload(recording)}
                            disabled={!deviceConnected || deviceSyncing || downloadQueue.has(recording.deviceFilename)}
                            title="Download">
                            {downloadQueue.has(recording.deviceFilename) ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                          </Button>
                        )}
                        {canPlay && hasLocalPath(recording) && (
                          <Button variant="ghost" size="icon" className="h-6 w-6"
                            onClick={() => {
                              if (currentlyPlayingId === recording.id) {
                                audioControls.stop()
                              } else {
                                audioControls.play(recording.id, recording.localPath)
                              }
                            }}
                            title="Play">
                            {currentlyPlayingId === recording.id ? <X className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                          </Button>
                        )}
                        {/* Transcribe button */}
                        {hasLocalPath(recording) && recording.transcriptionStatus !== 'complete' && recording.transcriptionStatus !== 'processing' && (
                          <Button variant="ghost" size="icon" className="h-6 w-6 text-accent-strong hover:text-accent-strong-hover"
                            onClick={() => handleTranscribe(recording)}
                            disabled={transcribing === recording.id}
                            title="Transcribe">
                            {transcribing === recording.id ? <RefreshCw className="h-3 w-3 animate-spin" /> : <FileAudio className="h-3 w-3" />}
                          </Button>
                        )}
                        {/* Delete - device-only: delete from device */}
                        {recording.location === 'device-only' && (
                          <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive"
                            onClick={() => handleDeleteFromDevice(recording)}
                            disabled={!deviceConnected || deleting === recording.id}
                            title="Delete from device">
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        )}
                        {/* Delete - local-only: delete local file */}
                        {recording.location === 'local-only' && (
                          <Button variant="ghost" size="icon" className="h-6 w-6 text-warning hover:text-warning"
                            onClick={() => handleDeleteLocal(recording)}
                            disabled={deleting === recording.id}
                            title="Delete local file">
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        )}
                        {/* Delete - both: delete local copy only */}
                        {recording.location === 'both' && (
                          <Button variant="ghost" size="icon" className="h-6 w-6 text-ink-muted hover:text-warning"
                            onClick={() => handleDeleteLocal(recording)}
                            disabled={deleting === recording.id}
                            title="Delete local copy">
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              /* Compact List View */
              <div className="space-y-px">
                {filteredRecordings.map((recording) => {
                  const canPlay = hasLocalPath(recording)
                  const isSelected = selectedIds.has(recording.id)

                  return (
                    <div
                      key={recording.id}
                      className={cn(
                        'flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm',
                        isSelected ? 'bg-accent-strong-soft' : 'hover:bg-surface-hover'
                      )}
                    >
                      {/* Checkbox */}
                      <button onClick={() => toggleSelection(recording.id)} className="flex-shrink-0">
                        {isSelected ? (
                          <CheckSquare className="h-4 w-4 text-accent-strong" />
                        ) : (
                          <Square className="h-4 w-4 text-ink-muted/50" />
                        )}
                      </button>

                      {/* Location */}
                      <StatusIcon location={recording.location} />

                      {/* Date */}
                      <span className="w-20 flex-shrink-0 text-xs text-ink-muted">
                        {formatShortDate(recording.dateRecorded)}
                      </span>

                      {/* Time */}
                      <span className="w-16 flex-shrink-0 text-xs text-ink-muted">
                        {formatShortTime(recording.dateRecorded)}
                      </span>

                      {/* Filename */}
                      <span className="flex-1 truncate font-mono text-xs text-ink" title={recording.filename}>
                        {recording.filename}
                      </span>

                      {/* Duration */}
                      <span className="w-14 flex-shrink-0 text-right text-xs text-ink-muted">
                        {recording.duration ? formatDuration(recording.duration) : '—'}
                      </span>

                      {/* Status icon */}
                      <span className="w-6 flex-shrink-0 text-center">
                        {recording.transcriptionStatus === 'complete' && <FileText className="inline h-3 w-3 text-success" />}
                        {recording.transcriptionStatus === 'processing' && <RefreshCw className="inline h-3 w-3 animate-spin text-warning" />}
                      </span>

                      {/* Actions */}
                      <div className="flex gap-1 flex-shrink-0">
                        {isDeviceOnly(recording) && (
                          <Button variant="ghost" size="icon" className="h-6 w-6"
                            onClick={(e) => { e.stopPropagation(); handleDownload(recording) }}
                            disabled={!deviceConnected || deviceSyncing || downloadQueue.has(recording.deviceFilename)}
                            title="Download from device">
                            {downloadQueue.has(recording.deviceFilename) ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                          </Button>
                        )}
                        {canPlay && hasLocalPath(recording) && (
                          <Button variant="ghost" size="icon" className="h-6 w-6"
                            onClick={(e) => {
                              e.stopPropagation()
                              if (currentlyPlayingId === recording.id) {
                                audioControls.stop()
                              } else {
                                audioControls.play(recording.id, recording.localPath)
                              }
                            }}
                            title="Play">
                            {currentlyPlayingId === recording.id ? <X className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                          </Button>
                        )}
                        {/* Transcribe button - show for local recordings without transcript */}
                        {hasLocalPath(recording) && recording.transcriptionStatus !== 'complete' && recording.transcriptionStatus !== 'processing' && (
                          <Button variant="ghost" size="icon" className="h-6 w-6 text-accent-strong hover:text-accent-strong-hover"
                            onClick={(e) => { e.stopPropagation(); handleTranscribe(recording) }}
                            disabled={transcribing === recording.id}
                            title="Transcribe">
                            {transcribing === recording.id ? <RefreshCw className="h-3 w-3 animate-spin" /> : <FileAudio className="h-3 w-3" />}
                          </Button>
                        )}
                        {/* Delete from device - only for device-only recordings */}
                        {recording.location === 'device-only' && (
                          <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive"
                            onClick={(e) => { e.stopPropagation(); handleDeleteFromDevice(recording) }}
                            disabled={!deviceConnected || deleting === recording.id}
                            title="Delete from device">
                            {deleting === recording.id ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                          </Button>
                        )}
                        {/* Delete local - only for local-only recordings */}
                        {recording.location === 'local-only' && (
                          <Button variant="ghost" size="icon" className="h-6 w-6 text-warning hover:text-warning"
                            onClick={(e) => { e.stopPropagation(); handleDeleteLocal(recording) }}
                            disabled={deleting === recording.id}
                            title="Delete local file">
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        )}
                        {/* Delete for synced recordings (both locations) - deletes local copy only */}
                        {recording.location === 'both' && (
                          <Button variant="ghost" size="icon" className="h-6 w-6 text-ink-muted hover:text-warning"
                            onClick={(e) => { e.stopPropagation(); handleDeleteLocal(recording) }}
                            disabled={deleting === recording.id}
                            title="Delete local copy (keeps on device)">
                            {deleting === recording.id ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                          </Button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Audio player */}
          {currentlyPlayingId && (
            <div className="flex-shrink-0 border-t border-border bg-surface p-4">
              {(() => {
                const rec = filteredRecordings.find(r => r.id === currentlyPlayingId)
                if (rec && hasLocalPath(rec)) {
                  return (
                    <AudioPlayer
                      filename={rec.filename}
                      onClose={() => audioControls.stop()}
                    />
                  )
                }
                return null
              })()}
            </div>
          )}
        </div>
      </>) : calendarView === 'month' ? (
        /* Month View */
        /* TODO (CA-09): Design inconsistency - Month view is meeting-centric (shows meetings with
           recording indicators), while Week/Day view is recording-centric (shows recordings with
           meeting overlays). Both views should ideally show BOTH meetings AND recordings to provide
           a consistent experience. Suggested approach: add recording blocks to month view cells and
           add meeting blocks as primary items to week/day view alongside recordings. */
        <div className="flex-1 flex flex-col min-h-0">
          {/* C-CAL-003: Sync indicator for calendar views */}
          {calendarSyncing && (
            <div className="flex flex-shrink-0 items-center gap-2 border-b border-border bg-accent-strong-soft px-[var(--space-5)] py-1.5 font-mono text-[11px] text-[var(--accent-soft-text)]">
              <RefreshCw className="h-3 w-3 animate-spin" />
              <span>Syncing calendar...</span>
            </div>
          )}
          {/* Day of Week Headers */}
          <div className="grid flex-shrink-0 grid-cols-7 border-b border-border">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, idx) => (
              <div key={day} className={cn(
                'border-l border-border py-2 text-center font-mono text-[10px] uppercase tracking-[0.08em] first:border-l-0',
                !workDays.includes(idx) ? 'bg-surface-sunken text-ink-muted' : 'text-ink-muted'
              )}>
                {day}
              </div>
            ))}
          </div>

          {/* Month Grid */}
          <div className="flex-1 overflow-auto">
            <div className="grid grid-cols-7 h-full" style={{ gridAutoRows: 'minmax(100px, 1fr)' }}>
              {monthDates.map((date) => {
                const key = date.toISOString().split('T')[0]
                const dayMeetings = meetingsByMonth[key] || []
                const today = isToday(date)
                const isCurrentMonth = date.getMonth() === currentDate.getMonth()
                const isWeekend = !isWorkDay(date)
                // C-CAL-006: Count recordings for this day to show indicator badge
                const dayRecordingCount = calendarRecordings.filter(r => {
                  const rKey = r.startTime.toISOString().split('T')[0]
                  return rKey === key
                }).length

                return (
                  <div
                    key={key}
                    className={cn(
                      'min-h-[100px] border-b border-l border-border p-1 first:border-l-0',
                      !isCurrentMonth && 'bg-surface-sunken',
                      isWeekend && isCurrentMonth && 'bg-bg-sunken',
                      today && 'ring-2 ring-inset ring-accent-strong/30'
                    )}
                  >
                    {/* Date Number with recording count badge */}
                    <div className="mb-1 flex items-center justify-between">
                      <div className={cn(
                        'text-sm font-medium text-ink',
                        !isCurrentMonth && 'text-ink-muted',
                        today && 'flex h-6 w-6 items-center justify-center rounded-full bg-accent-strong text-[var(--on-accent)]'
                      )}>
                        {date.getDate()}
                      </div>
                      {/* C-CAL-006: Recording count indicator */}
                      {dayRecordingCount > 0 && (
                        <span className="flex items-center gap-0.5 font-mono text-[10px] text-accent-strong">
                          <Mic className="h-2.5 w-2.5" />
                          {dayRecordingCount}
                        </span>
                      )}
                    </div>

                    {/* Meetings for this day */}
                    <div className="space-y-1">
                      {dayMeetings.slice(0, 3).map((meeting) => (
                        <button
                          key={meeting.id}
                          onClick={() => {
                            // C-CAL-004: All meeting cards should be clickable.
                            // Placeholders open the link dialog; real meetings navigate to detail.
                            if (meeting.isPlaceholder && meeting.matchedRecordingId) {
                              setLinkDialogRecording({
                                id: meeting.matchedRecordingId,
                                filename: meeting.subject,
                                date_recorded: meeting.start_time,
                                duration_seconds: meeting.recordingDurationSeconds ?? null
                              })
                            } else if (!meeting.isPlaceholder) {
                              handleMeetingClick(meeting)
                            }
                          }}
                          className={cn(
                            'w-full truncate rounded p-1 text-left text-xs transition-colors',
                            'hover:ring-1 hover:ring-ring',
                            meeting.hasRecording && !meeting.isPlaceholder && 'bg-success-soft text-success',
                            meeting.isPlaceholder && 'border border-dashed border-warning/40 bg-warning-soft text-warning',
                            meeting.recordingLocation === 'device-only' && 'bg-warning-soft text-warning',
                            !meeting.hasRecording && !meeting.isPlaceholder && 'border border-dashed border-border-strong bg-surface-sunken text-ink-muted opacity-60',
                            meeting.hasConflicts && 'ring-1 ring-warning'
                          )}
                        >
                          <span className="flex items-center gap-1">
                            {meeting.hasRecording && meeting.recordingLocation && (
                              <StatusIcon location={meeting.recordingLocation} />
                            )}
                            {meeting.hasRecording && !meeting.recordingLocation && (
                              <Mic className="h-3 w-3 flex-shrink-0" />
                            )}
                            <span className="truncate">{meeting.subject}</span>
                          </span>
                        </button>
                      ))}
                      {dayMeetings.length > 3 && (
                        <div className="pl-1 text-xs text-ink-muted">
                          +{dayMeetings.length - 3} more
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      ) : (
        /* Day/Workweek/Week View — recording-centric (see CA-09 TODO above for inconsistency) */
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {/* C-CAL-003: Sync indicator for week/day views */}
          {calendarSyncing && (
            <div className="flex flex-shrink-0 items-center gap-2 border-b border-border bg-accent-strong-soft px-[var(--space-5)] py-1.5 font-mono text-[11px] text-[var(--accent-soft-text)]">
              <RefreshCw className="h-3 w-3 animate-spin" />
              <span>Syncing calendar...</span>
            </div>
          )}
          {/* Day Headers - fixed, with scrollbar gutter to match content */}
          <div className="flex flex-shrink-0 overflow-y-scroll border-b border-border" style={{ scrollbarGutter: 'stable' }}>
            <div className="w-14 flex-shrink-0" />
            {viewDates.map((date) => {
              const key = date.toISOString().split('T')[0]
              const today = isToday(date)
              const isWeekend = !isWorkDay(date)

              return (
                <div
                  key={key}
                  className={cn(
                    'flex-1 border-l border-border py-3 text-center',
                    isWeekend && 'bg-surface-sunken',
                    today && 'ring-2 ring-inset ring-accent-strong/30'
                  )}
                >
                  <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted">
                    {date.toLocaleDateString('en-US', { weekday: calendarView === 'day' ? 'long' : 'short' })}
                  </div>
                  <div
                    className={cn(
                      'mt-1 font-display text-[17px] font-semibold text-ink',
                      today && 'mx-auto flex h-8 w-8 items-center justify-center rounded-full bg-accent-strong text-[var(--on-accent)]'
                    )}
                  >
                    {date.getDate()}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Time Grid - scrollable, with stable scrollbar gutter */}
          <div ref={scrollContainerRef} className="flex-1 overflow-auto" style={{ scrollbarGutter: 'stable' }}>
            <div className="flex min-h-full">
              {/* Time Labels - B-CAL-003: Uses dynamic visibleHours */}
              <div className="w-14 flex-shrink-0 bg-bg">
                {visibleHours.map((hour) => (
                  <div
                    key={hour}
                    className="relative"
                    style={{ height: HOUR_HEIGHT }}
                  >
                    <span className="absolute -top-2 right-2 font-mono text-[10px] text-ink-muted">
                      {hour === 12 ? '12 PM' : hour > 12 ? `${hour - 12} PM` : `${hour} AM`}
                    </span>
                  </div>
                ))}
              </div>

              {/* Day Columns */}
              {viewDates.map((date) => {
                const key = date.toISOString().split('T')[0]
                // dayMeetings variable reserved for future per-day rendering
                const _dayMeetings = meetingsByDay[key] || []
                void _dayMeetings
                const today = isToday(date)
                const isWeekend = !isWorkDay(date)

                return (
                  <div
                    key={key}
                    className={cn(
                      'relative flex-1 border-l border-border',
                      isWeekend && 'bg-surface-sunken/50',
                      today && 'ring-2 ring-inset ring-accent-strong/20'
                    )}
                  >
                    {/* Hour Lines with office hours shading - B-CAL-003: dynamic hours */}
                    {visibleHours.map((hour) => (
                      <div
                        key={hour}
                        className={cn(
                          'border-b border-border/40',
                          !isOfficeHour(hour) && !isWeekend && 'bg-surface-sunken/60'
                        )}
                        style={{ height: HOUR_HEIGHT }}
                      />
                    ))}

                    {/* Current Time Indicator (CA-05: updates every 60s) */}
                    {today && (
                      <CurrentTimeIndicator startHour={visibleStartHour} hourHeight={HOUR_HEIGHT} />
                    )}

                    {/* ===== MEETING OVERLAYS (DASHED - SECONDARY) ===== */}
                    {/* Meetings WITHOUT recordings shown as dashed ghost blocks */}
                    {(meetingOverlaysByDay[key] || []).map((meeting) => {
                      const { top, height } = getMeetingOverlayStyle(meeting)

                      const startHour = meeting.startTime.getHours()
                      // B-CAL-003: Dynamic hour range now adjusts to fit events, so this filter
                      // only hides truly out-of-range items (should be rare with dynamic range)
                      if (startHour < visibleStartHour || startHour >= visibleEndHour) return null

                      const canShowTime = height > 35

                      return (
                        <Tooltip key={`overlay-${meeting.id}`}>
                          <TooltipTrigger asChild>
                            <button
                              onClick={() => handleMeetingClick({ id: meeting.id } as Meeting)}
                              className={cn(
                                'absolute left-1 w-[calc(100%-8px)] overflow-hidden rounded-md px-2 py-1 text-left text-xs transition-all',
                                'border-[1.5px] border-dashed border-border-strong',
                                'bg-surface text-ink-muted',
                                'hover:border-border-strong hover:bg-surface-hover',
                                'opacity-70 hover:opacity-100'
                              )}
                              style={{
                                top,
                                height,
                                minHeight: 24,
                                zIndex: 5 // Below recordings
                              }}
                            >
                              <div className="flex items-start gap-1 h-full">
                                <div className="flex-1 min-w-0">
                                  <div className="font-medium leading-tight truncate">
                                    {meeting.subject}
                                  </div>
                                  {canShowTime && (
                                    <div className="text-[10px] mt-0.5 opacity-70">
                                      {formatTime(meeting.startTime.toISOString())} - {formatTime(meeting.endTime.toISOString())}
                                    </div>
                                  )}
                                </div>
                              </div>
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="right" align="start">
                            <MeetingOverlayTooltipContent meeting={meeting} />
                          </TooltipContent>
                        </Tooltip>
                      )
                    })}

                    {/* ===== RECORDINGS (SOLID - PRIMARY) ===== */}
                    {/* Recordings shown as solid blocks - positioned by RECORDING time */}
                    {(recordingsByDay[key] || []).map((recording, recIdx) => {
                      const { top, height } = getRecordingStyle(recording)

                      const startHour = recording.startTime.getHours()
                      if (startHour < visibleStartHour || startHour >= visibleEndHour) return null

                      const canShowTime = height > 35
                      const canShowMultiline = height > 60

                      // Display label: meeting subject if linked, otherwise filename
                      const displayLabel = recording.linkedMeeting?.subject || recording.filename

                      return (
                        <Tooltip key={recording.id}>
                          <TooltipTrigger asChild>
                            <button
                              onClick={() => handleRecordingClick(recording)}
                              className={cn(
                                'absolute left-1 w-[calc(100%-8px)] overflow-hidden rounded-sm px-2 py-1 text-left text-xs transition-all',
                                'hover:z-30 hover:shadow-lg hover:ring-2 hover:ring-ring',
                                'shadow-xs',
                                // Synced/downloaded recording (primary accent — matches prototype)
                                (recording.location === 'both' || recording.location === 'local-only') &&
                                  'border-l-[3px] border-accent-strong bg-accent-strong-soft text-[var(--accent-soft-text)]',
                                // Device-only recording (warning)
                                recording.location === 'device-only' &&
                                  'border-l-[3px] border-warning bg-warning-soft text-warning',
                                // No linked meeting - teal voice/match cue
                                !recording.linkedMeeting && recording.location !== 'device-only' &&
                                  'border-l-[3px] border-accent-2 bg-accent-2-soft text-accent-2'
                              )}
                              style={{
                                top,
                                height,
                                minHeight: 24,
                                zIndex: 15 + recIdx // Above meeting overlays
                              }}
                            >
                              <div className="flex items-start gap-1 h-full relative z-10">
                                <Mic className="h-3 w-3 flex-shrink-0 mt-0.5 opacity-90" />
                                <div className="flex-1 min-w-0">
                                  <div className={cn(
                                    'font-semibold leading-tight',
                                    canShowMultiline ? 'line-clamp-2' : 'truncate'
                                  )}>
                                    {displayLabel}
                                  </div>
                                  {canShowTime && (
                                    <div className={cn(
                                      'text-[10px] mt-0.5 opacity-80',
                                      canShowMultiline ? '' : 'truncate'
                                    )}>
                                      {formatTime(recording.startTime.toISOString())} - {formatTime(recording.endTime.toISOString())}
                                      {recording.durationSeconds > 0 && ` (${formatDurationStr(recording.durationSeconds)})`}
                                    </div>
                                  )}
                                </div>
                                <StatusIcon location={recording.location} />
                              </div>
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="right" align="start">
                            <RecordingTooltipContent recording={recording} />
                          </TooltipContent>
                        </Tooltip>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>

      {/* Recording Link Dialog */}
      <RecordingLinkDialog
        recording={linkDialogRecording}
        open={!!linkDialogRecording}
        onClose={() => setLinkDialogRecording(null)}
        onResolved={() => {
          setLinkDialogRecording(null)
          if (!viewDates.length) return
          const startDate = viewDates[0].toISOString()
          const endDate = new Date(viewDates[viewDates.length - 1])
          endDate.setHours(23, 59, 59, 999)
          loadMeetings(startDate, endDate.toISOString())
        }}
      />
    </TooltipProvider>
  )
}

export default Calendar
