/**
 * useDataFreshnessBridge — the single place that turns server-originated completion
 * events into coalesced data-freshness pulses. Mount ONCE (in Layout).
 *
 * Mapping (see the spec's Task 2 Decisions):
 *   recording:new                     → recordings
 *   download completion (edge)        → recordings
 *   transcription:completed           → recordings + actionables + projects
 *   transcription:failed              → recordings
 *   WS reconnect                      → all topics (recover events missed while offline)
 *
 * Works in both transports: it consumes the `window.electronAPI.on*` methods, which
 * exist under the hosted REST SDK (WebSocket) and the desktop preload (IPC). The
 * reconnect signal only ever fires in hosted mode (desktop has a persistent bridge).
 */

import { useEffect, useRef } from 'react'
import { emitFreshness, ALL_TOPICS } from '@/lib/dataFreshness'

export function useDataFreshnessBridge(): void {
  // download-service:state-update fires on every progress tick, so we edge-detect
  // completion: emit only when the count of completed queue items increases.
  const prevDownloadCompletedRef = useRef(0)

  useEffect(() => {
    const api = window.electronAPI
    if (!api) return

    const unsubs: Array<() => void> = []

    if (api.onRecordingAdded) {
      unsubs.push(api.onRecordingAdded(() => emitFreshness('recordings')))
    }

    if (api.onTranscriptionCompleted) {
      unsubs.push(
        api.onTranscriptionCompleted(() => {
          // A completed transcript changes the recording row and can spawn new
          // actionables and project associations.
          emitFreshness('recordings')
          emitFreshness('actionables')
          emitFreshness('projects')
        })
      )
    }

    if (api.onTranscriptionFailed) {
      unsubs.push(api.onTranscriptionFailed(() => emitFreshness('recordings')))
    }

    if (api.downloadService?.onStateUpdate) {
      unsubs.push(
        api.downloadService.onStateUpdate((state: { queue?: Array<{ status?: string }> }) => {
          const completed = (state?.queue ?? []).filter((q) => q?.status === 'completed').length
          if (completed > prevDownloadCompletedRef.current) {
            emitFreshness('recordings')
          }
          prevDownloadCompletedRef.current = completed
        })
      )
    }

    if (api.onConnectionRestored) {
      unsubs.push(
        api.onConnectionRestored(() => {
          for (const topic of ALL_TOPICS) emitFreshness(topic)
        })
      )
    }

    return () => {
      unsubs.forEach((u) => u())
    }
  }, [])
}
