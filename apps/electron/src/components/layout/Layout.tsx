import { ReactNode, useEffect, useState, useRef } from 'react'
import { useLocation, Link } from 'react-router-dom'
import {
  Home,
  Users,
  Folder,
  Calendar,
  CloudDownload,
  BookOpen,
  Bot,
  Compass,
  ListTodo,
  Settings,
  Anchor,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  Terminal,
  ChevronDown,
  ChevronUp
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  useAppStore,
  useLastCalendarSync,
  useDeviceState,
  useConnectionStatus,
  useActivityLog
} from '@/store/useAppStore'
import { useConfigStore } from '@/store/domain/useConfigStore'

type LucideIcon = typeof BookOpen
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { toast } from '@/components/ui/toaster'
import { OperationController } from '@/components/OperationController'
import { OperationsPanel } from '@/components/layout/OperationsPanel'
import { useUIStore } from '@/store/ui/useUIStore'
import { Switch } from '@/components/ui/switch'

interface LayoutProps {
  children: ReactNode
}

// Navigation structure with sections (Harbor groups)
type NavigationSection = {
  title: string
  items: Array<{ name: string; href: string; icon: LucideIcon }>
}

const navigationSections: NavigationSection[] = [
  {
    title: 'Knowledge',
    items: [
      { name: 'Home', href: '/home', icon: Home },
      { name: 'Library', href: '/library', icon: BookOpen },
      { name: 'Assistant', href: '/assistant', icon: Bot },
      { name: 'Explore', href: '/explore', icon: Compass }
    ]
  },
  {
    title: 'Capture',
    items: [{ name: 'Sync', href: '/sync', icon: CloudDownload }]
  },
  {
    title: 'Organization',
    items: [
      { name: 'People', href: '/people', icon: Users },
      { name: 'Projects', href: '/projects', icon: Folder },
      { name: 'Calendar', href: '/calendar', icon: Calendar }
    ]
  },
  {
    title: 'Actions',
    items: [{ name: 'Actionables', href: '/actionables', icon: ListTodo }]
  }
]

export function Layout({ children }: LayoutProps) {
  const location = useLocation()
  const [isDevMode, setIsDevMode] = useState(false)
  // SM-02 fix: Use granular selectors instead of destructuring entire store
  const loadMeetings = useAppStore((s) => s.loadMeetings)
  const syncCalendar = useAppStore((s) => s.syncCalendar)
  const lastCalendarSync = useLastCalendarSync()
  const deviceState = useDeviceState()
  const connectionStatus = useConnectionStatus()
  const { config, loadConfig } = useConfigStore()
  const sidebarOpen = useUIStore((s) => s.sidebarOpen)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const qaLogsEnabled = useUIStore((s) => s.qaLogsEnabled)
  const setQaLogsEnabled = useUIStore((s) => s.setQaLogsEnabled)

  // AL-001: Global activity log — visible from all pages
  const activityLog = useActivityLog()
  const [logExpanded, setLogExpanded] = useState(false)
  const logContainerRef = useRef<HTMLDivElement>(null)
  const hasErrors = activityLog.some(e => e.type === 'error' || e.type === 'warning')

  // AL-004: Auto-scroll when expanded or new entries arrive
  useEffect(() => {
    if (logExpanded && activityLog.length > 0 && logContainerRef.current) {
      requestAnimationFrame(() => {
        if (logContainerRef.current) {
          logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight
        }
      })
    }
  }, [activityLog.length, logExpanded])

  // Track previous state for toast notifications
  const prevConnectedRef = useRef<boolean | null>(null)
  const prevStatusStepRef = useRef<string | null>(null)
  const hasShownInitialToast = useRef(false)

  // Check if running in dev mode
  useEffect(() => {
    if (window.electronAPI?.app) {
      window.electronAPI.app.info().then((info) => {
        setIsDevMode(!info.isPackaged)
      })
    } else {
      // Not in Electron, assume dev mode
      setIsDevMode(true)
    }
  }, [])

  // Initialize app on mount
  useEffect(() => {
    loadConfig()
    loadMeetings()
    // loadRecordings() // Redundant: Pages load their own data via useUnifiedRecordings
  }, [])

  // Toast notifications for device state changes (read from store)
  useEffect(() => {
    // Initialize refs with current state (don't show toast on initial load)
    if (prevConnectedRef.current === null) {
      prevConnectedRef.current = deviceState.connected
      prevStatusStepRef.current = connectionStatus.step
      return
    }

    const wasConnected = prevConnectedRef.current
    const isNowConnected = deviceState.connected

    // Show toast on connection state change
    if (wasConnected !== isNowConnected) {
      if (isNowConnected) {
        const modelName = deviceState.model?.replace('hidock-', '').toUpperCase() || 'Device'
        toast({
          title: 'Device Connected',
          description: `${modelName} is ready to use`,
          variant: 'success'
        })
        hasShownInitialToast.current = true
      } else {
        // Only show disconnect toast if we had previously shown a connect toast
        if (hasShownInitialToast.current) {
          toast({
            title: 'Device Disconnected',
            description: 'HiDock has been disconnected',
            variant: 'default'
          })
        }
      }
    }

    prevConnectedRef.current = isNowConnected
  }, [deviceState.connected, deviceState.model])

  // Toast notifications for connection errors (read from store)
  useEffect(() => {
    // Initialize ref with current state
    if (prevStatusStepRef.current === null) {
      prevStatusStepRef.current = connectionStatus.step
      return
    }

    const prevStep = prevStatusStepRef.current

    // Show toast on error state
    if (connectionStatus.step === 'error' && prevStep !== 'error') {
      toast({
        title: 'Connection Error',
        description: connectionStatus.message || 'Failed to connect to device',
        variant: 'error'
      })
    }

    prevStatusStepRef.current = connectionStatus.step
  }, [connectionStatus.step, connectionStatus.message])

  // Initial calendar sync if URL is configured
  useEffect(() => {
    if (config?.calendar.icsUrl && !lastCalendarSync) {
      syncCalendar()
    }
  }, [config?.calendar.icsUrl])

  // Determine device status display
  const isConnected = deviceState.connected
  const isConnecting = connectionStatus.step !== 'idle' && connectionStatus.step !== 'ready' && connectionStatus.step !== 'error'
  const isScanning = connectionStatus.step === 'counting-files'
  const deviceModel = deviceState.model?.replace('hidock-', '').toUpperCase() || 'Device'
  const isSettingsActive = location.pathname.startsWith('/settings')

  return (
    <div className="flex h-screen bg-background text-foreground">
      {/* Background operations controller - never unmounts, handles ALL operations */}
      <OperationController />

      {/* Sidebar (Harbor) */}
      <aside
        className={cn(
          'flex flex-col border-r border-border bg-surface transition-all duration-300',
          sidebarOpen ? 'w-[248px]' : 'w-[66px]'
        )}
      >
        {/* Brand / collapse */}
        <div
          className={cn(
            'flex items-center gap-2.5 px-4 pb-3 pt-4 titlebar-drag-region',
            !sidebarOpen && 'justify-center px-0'
          )}
        >
          <div className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-md bg-brand-navy text-white titlebar-no-drag">
            <Anchor className="h-5 w-5" />
          </div>
          {sidebarOpen && (
            <div className="min-w-0 flex-1 leading-tight titlebar-no-drag">
              <div className="font-display text-[19px] font-semibold tracking-[-0.01em] text-ink">HiDock</div>
              <div className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-accent-2">calm from the noise</div>
            </div>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 titlebar-no-drag text-ink-muted hover:text-ink"
            onClick={toggleSidebar}
          >
            {sidebarOpen ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </Button>
        </div>

        {/* Device status pill */}
        <div className={cn('shrink-0 px-3 pb-3', !sidebarOpen && 'px-2')}>
          <Tooltip>
          <TooltipTrigger asChild>
          <Link
            to="/sync"
            aria-label={`${isConnected ? deviceModel : isConnecting ? 'Connecting…' : 'Disconnected'}`}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-lg border border-border bg-surface-sunken px-3 py-2.5 text-left transition-colors hover:border-border-strong',
              !sidebarOpen && 'justify-center px-0'
            )}
          >
            <span className="relative flex h-[9px] w-[9px] shrink-0 items-center justify-center">
              {isConnected ? (
                <span className="h-[9px] w-[9px] rounded-full bg-success shadow-[0_0_0_3px_var(--success-soft)]" />
              ) : isConnecting ? (
                <span className="h-[9px] w-[9px] animate-pulse rounded-full bg-warning" />
              ) : (
                <span className="h-[9px] w-[9px] rounded-full bg-border-strong" />
              )}
            </span>
            {sidebarOpen && (
              <span className="min-w-0 flex-1">
                <span className="block text-[12.5px] font-semibold text-ink">
                  {isConnected ? `hidock-${deviceModel.toLowerCase()}` : isConnecting ? 'Connecting…' : 'Disconnected'}
                </span>
                <span className="block truncate font-mono text-[10px] text-ink-muted">
                  {isConnected && isScanning
                    ? connectionStatus.message
                    : isConnected
                      ? `connected${deviceState.recordingCount > 0 ? ` · ${deviceState.recordingCount} files` : ''}`
                      : isConnecting
                        ? 'establishing link'
                        : 'click to connect'}
                </span>
              </span>
            )}
          </Link>
          </TooltipTrigger>
          <TooltipContent>
            {isConnected ? deviceModel : isConnecting ? 'Connecting…' : 'Disconnected'}
          </TooltipContent>
          </Tooltip>
        </div>

        {/* Navigation */}
        <nav className="flex-1 space-y-4 overflow-y-auto px-3">
          {navigationSections.map((section) => (
            <div key={section.title}>
              {sidebarOpen && (
                <div className="px-2.5 pb-2 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
                  {section.title}
                </div>
              )}
              <div className="space-y-0.5">
                {section.items.map((item) => {
                  const isActive = location.pathname.startsWith(item.href)
                  return (
                    <Link
                      key={item.href}
                      to={item.href}
                      title={item.name}
                      className={cn(
                        'flex items-center gap-3 rounded-md px-2.5 py-2 text-[13.5px] transition-colors',
                        !sidebarOpen && 'justify-center px-0',
                        isActive
                          ? 'bg-accent-strong-soft font-semibold text-[var(--accent-soft-text)]'
                          : 'font-medium text-foreground hover:bg-surface-hover hover:text-ink'
                      )}
                    >
                      <item.icon className="h-[18px] w-[18px] shrink-0" />
                      {sidebarOpen && <span className="flex-1">{item.name}</span>}
                    </Link>
                  )
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* User / Settings row */}
        <Link
          to="/settings"
          title="Settings"
          className={cn(
            'mx-3 mb-1 mt-2 flex items-center gap-3 rounded-md px-2 py-2 transition-colors',
            !sidebarOpen && 'mx-2 justify-center px-0',
            isSettingsActive ? 'bg-accent-strong-soft' : 'hover:bg-surface-hover'
          )}
        >
          <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-[var(--blue-600)] text-[12px] font-semibold text-white">
            RC
          </span>
          {sidebarOpen && (
            <>
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block text-[12.5px] font-semibold text-ink">Roger Cox</span>
                <span className="block text-[10.5px] text-ink-muted">workspace owner</span>
              </span>
              <Settings className="h-4 w-4 shrink-0 text-ink-muted" />
            </>
          )}
        </Link>

        {/* Operations Panel - Downloads + Transcriptions */}
        <OperationsPanel sidebarOpen={sidebarOpen} />

        {/* AL-001: Global Activity Log — accessible from all pages */}
        <div className="border-t border-border">
          {sidebarOpen ? (
            <div>
              <button
                className="flex w-full items-center justify-between px-3 py-2 text-xs text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
                onClick={() => setLogExpanded(p => !p)}
              >
                <span className="flex items-center gap-1.5">
                  <Terminal className="h-3.5 w-3.5" />
                  Activity Log
                  {activityLog.length > 0 && (
                    <span className={cn(
                      'rounded px-1 text-[10px]',
                      hasErrors ? 'bg-danger-soft text-danger' : 'bg-surface-sunken text-ink-muted'
                    )}>
                      {activityLog.length}
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-1">
                  <span
                    className="text-[10px] hover:text-ink"
                    onClick={(e) => {
                      e.stopPropagation()
                      useAppStore.getState().clearActivityLog?.()
                    }}
                    title="Clear log"
                  >Clear</span>
                  {logExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
                </span>
              </button>
              {logExpanded && (
                <div
                  ref={logContainerRef}
                  className="max-h-40 overflow-y-auto bg-bg-sunken px-2 py-1 font-mono"
                >
                  {activityLog.length === 0 ? (
                    <p className="py-1 text-[10px] text-ink-muted">No activity</p>
                  ) : (
                    activityLog.map((entry, i) => (
                      <div key={`${entry.timestamp.getTime()}-${i}`}
                        className={cn(
                          'py-0.5 text-[10px] leading-4',
                          entry.type === 'error' ? 'text-danger'
                          : entry.type === 'success' ? 'text-success'
                          : entry.type === 'warning' ? 'text-warning'
                          : entry.type === 'usb-out' ? 'text-[var(--blue-500)]'
                          : entry.type === 'usb-in' ? 'text-accent-2'
                          : 'text-ink-muted'
                        )}>
                        <span className="mr-1 text-ink-muted/70">
                          {entry.timestamp.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </span>
                        {entry.message}
                        {entry.details && <span className="ml-1 text-ink-muted/70">— {entry.details}</span>}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          ) : hasErrors ? (
            <div className="flex justify-center py-2" title="Activity log has errors or warnings">
              <Terminal className="h-4 w-4 text-warning" />
            </div>
          ) : null}
        </div>

        {/* Dev Tools */}
        {isDevMode && (
          <div className="space-y-2 border-t border-border p-3">
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                'w-full gap-2 bg-surface-sunken text-ink hover:bg-surface-hover',
                !sidebarOpen && 'justify-center px-0'
              )}
              onClick={() => window.electronAPI?.app?.restart()}
              title="Restart App"
            >
              <RotateCcw className="h-4 w-4" />
              {sidebarOpen && <span>Restart</span>}
            </Button>
            {sidebarOpen && (
              <div className="flex items-center justify-between">
                <span className="text-xs text-ink-muted">QA Logs</span>
                <Switch
                  checked={qaLogsEnabled}
                  onCheckedChange={setQaLogsEnabled}
                />
              </div>
            )}
          </div>
        )}
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-hidden">{children}</main>
    </div>
  )
}
