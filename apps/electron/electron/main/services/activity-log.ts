/**
 * Activity Log Bridge — main process to renderer IPC
 *
 * Main process services (transcription, calendar-sync, download-service) run
 * isolated from the renderer's HiDockDeviceService. They cannot call
 * deviceService.logActivity() directly. This module provides a lightweight
 * IPC bridge that emits activity log entries to the renderer window.
 *
 * Usage:
 *   import { emitActivityLog } from './activity-log'
 *   emitActivityLog('info', 'Syncing calendar...', 'Fetching from ICS URL')
 */

import { getBroadcaster } from './broadcaster'

export type ActivityLogType = 'error' | 'success' | 'info' | 'warning' | 'usb-in' | 'usb-out'

export interface ActivityLogEntry {
  type: ActivityLogType
  message: string
  details?: string
  timestamp: Date
}

/**
 * Emit an activity log entry to the renderer window.
 * Fire-and-forget — safe to call from anywhere in the main process.
 */
export function emitActivityLog(
  type: ActivityLogType,
  message: string,
  details?: string
): void {
  const entry: ActivityLogEntry = {
    type,
    message,
    details,
    timestamp: new Date()
  }

  getBroadcaster().broadcast('activity-log:entry', entry)
}
