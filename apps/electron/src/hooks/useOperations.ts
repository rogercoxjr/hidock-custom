import { useCallback } from 'react'
import { toast } from '@/components/ui/toaster'
import { useTranscriptionStore } from '@/store/features/useTranscriptionStore'
import { cancelDownloads, cancelDownloadsComplete } from '@/hooks/useDownloadOrchestrator'
import type { UnifiedRecording } from '@/types/unified-recording'
import { hasLocalPath, isDeviceOnly } from '@/types/unified-recording'
import type { ElectronAPI } from '@/lib/electron-api/types'

// TODO(Phase1 Task 12): window.electronAPI's *ambient* type is sourced from the real
// Electron desktop preload's ElectronAPI (electron/preload/index.ts, via
// electron/preload/index.d.ts's `declare global`), which doesn't (and structurally can't,
// without a desktop-side implementation) include the hosted-mode-only REST facade members
// `deviceSync` / `downloadService.deviceFileSource` — those are composed onto
// `window.electronAPI` at runtime by `installRestApi()` (src/lib/electron-api/index.ts,
// Task 12) and typed on the renderer's own `ElectronAPI` in src/lib/electron-api/types.ts.
// Verified the two ElectronAPI interfaces are otherwise a byte-identical/superset match
// (2026-07-06) — this narrow cast bridges the gap for hosted mode without widening the
// ambient global (out of this task's scope; that reconciliation belongs with Task 12).
// Read fresh on every call (not cached at module scope) so tests that reassign
// `window.electronAPI` per-case still see the current mock.
function hostedApi(): ElectronAPI {
  return window.electronAPI as unknown as ElectronAPI
}

/**
 * Centralized hook for all download and transcription operations.
 *
 * Every component that triggers downloads or transcriptions MUST use this hook
 * instead of calling IPC directly. This ensures:
 * - Consistent toast notifications
 * - Store updates for sidebar panel
 * - Error handling with user-visible messages
 * - DRY: single place to change operation behavior
 */
export function useOperations() {
  const addToQueue = useTranscriptionStore((s) => s.addToQueue)

  // ── Transcription ──────────────────────────────────────

  const queueTranscription = useCallback(async (recording: UnifiedRecording, opts?: { force?: boolean }) => {
    if (!hasLocalPath(recording)) {
      toast({ title: 'Cannot transcribe', description: 'File not available locally. Download first.', variant: 'error' })
      return false
    }
    // Never double-queue an actively-processing recording.
    if (recording.transcriptionStatus === 'processing') {
      return false
    }
    // A COMPLETE recording is normally a no-op — but a forced re-transcribe (D5 §6.8 /
    // AC6) must bypass this so the server-side marker-clear + speaker-mapping drop runs.
    if (recording.transcriptionStatus === 'complete' && !opts?.force) {
      return false
    }

    // Provider-aware preflight (spec §5.6) — replaces the hardcoded Gemini gate
    // so a Whisper+Ollama user can queue/retry without a Gemini key.
    try {
      const check = await window.electronAPI.recordings.validateTranscriptionConfig()
      if (!check.ok) {
        const p = check.problems[0]
        toast({
          title: 'API key required',
          description: `Configure your ${p.provider} API key in Settings before transcribing.`,
          variant: 'error'
        })
        return false
      }
    } catch (e) {
      console.error('Failed to validate transcription config:', e)
      toast({ title: 'Configuration error', description: 'Could not verify provider configuration', variant: 'error' })
      return false
    }

    try {
      await window.electronAPI.recordings.updateStatus(recording.id, 'pending')
      // A FORCED re-transcribe (D5 §6.8 / AC6) must route through recordings.transcribe —
      // the ONLY IPC that clears the stage markers (full_text/summarization_provider + the
      // diarization columns) and drops prior speaker mappings server-side BEFORE enqueueing.
      // The bare addToQueue path skips that clear, so the worker sees a still-complete
      // transcript and short-circuits ("already fully transcribed") — the live re-transcribe
      // bug. Both IPCs return the queue-item id so the in-app queue panel updates either way.
      const queueItemId = opts?.force
        ? await window.electronAPI.recordings.transcribe(recording.id)
        : await window.electronAPI.recordings.addToQueue(recording.id)
      if (!queueItemId) {
        toast({ title: 'Failed to queue transcription', description: 'Could not add to queue', variant: 'error' })
        return false
      }
      addToQueue(queueItemId, recording.id, recording.filename)
      toast({ title: opts?.force ? 'Re-transcription queued' : 'Transcription queued', description: recording.filename })
      return true
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error'
      toast({ title: 'Failed to queue transcription', description: msg, variant: 'error' })
      return false
    }
  }, [addToQueue])

  const queueBulkTranscriptions = useCallback(async (recordings: UnifiedRecording[]) => {
    const eligible = recordings.filter(
      (r) => hasLocalPath(r) && r.transcriptionStatus !== 'processing' && r.transcriptionStatus !== 'complete'
    )
    if (eligible.length === 0) {
      toast({ title: 'No recordings to transcribe', description: 'All selected recordings are already transcribed or in progress.' })
      return 0
    }

    // Provider-aware preflight (spec §5.6) — replaces the hardcoded Gemini gate
    // so a Whisper+Ollama user can queue/retry without a Gemini key.
    try {
      const check = await window.electronAPI.recordings.validateTranscriptionConfig()
      if (!check.ok) {
        const p = check.problems[0]
        toast({
          title: 'API key required',
          description: `Configure your ${p.provider} API key in Settings before transcribing.`,
          variant: 'error'
        })
        return 0
      }
    } catch (e) {
      console.error('Failed to validate transcription config:', e)
      toast({ title: 'Configuration error', description: 'Could not verify provider configuration', variant: 'error' })
      return 0
    }

    let queued = 0
    for (const recording of eligible) {
      try {
        await window.electronAPI.recordings.updateStatus(recording.id, 'pending')
        const queueItemId = await window.electronAPI.recordings.addToQueue(recording.id)
        if (queueItemId) {
          addToQueue(queueItemId, recording.id, recording.filename)
          queued++
        }
      } catch (e) {
        console.error('Failed to queue:', recording.filename, e)
      }
    }

    toast({ title: `${queued} transcription${queued > 1 ? 's' : ''} queued`, description: 'Processing will begin shortly.' })
    return queued
  }, [addToQueue])

  const cancelTranscription = useCallback(async (recordingId: string) => {
    try {
      await window.electronAPI.recordings.cancelTranscription(recordingId)
      // TQ-03 FIX: Find and remove queue item by recordingId, not by item ID
      const store = useTranscriptionStore.getState()
      const items = Array.from(store.queue.values())
      const item = items.find((i) => i.recordingId === recordingId)
      if (item) {
        store.remove(item.id)
      }
      toast({ title: 'Transcription cancelled' })
    } catch (e) {
      console.error('Failed to cancel transcription:', e)
    }
  }, [])

  const cancelAllTranscriptions = useCallback(async () => {
    try {
      const result = await window.electronAPI.recordings.cancelAllTranscriptions()
      useTranscriptionStore.getState().clear()
      toast({ title: 'All transcriptions cancelled', description: `${result.count} items removed from queue.` })
    } catch (e) {
      console.error('Failed to cancel transcriptions:', e)
    }
  }, [])

  // ── Downloads ──────────────────────────────────────────

  // Routes through the device sync client (renderer) rather than the stubbed
  // downloadService.queueDownloads — hosted mode has no local download queue, so the
  // device file is streamed straight to the server via deviceSync.syncFile.
  const queueDownload = useCallback(async (recording: UnifiedRecording) => {
    if (!isDeviceOnly(recording)) return false

    try {
      const src = hostedApi().downloadService.deviceFileSource(recording.deviceFilename, recording.size)
      const res = await hostedApi().deviceSync.syncFile(src)
      toast({ title: res.status === 'skipped' ? 'Already synced' : 'Synced', description: recording.filename })
      return true
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error'
      toast({ title: 'Sync failed', description: msg, variant: 'error' })
      return false
    }
  }, [])

  const queueBulkDownloads = useCallback(async (recordings: UnifiedRecording[]) => {
    const eligible = recordings.filter(isDeviceOnly)
    let done = 0
    // Serialized — one device claim at a time. The device has a single USB endpoint, so
    // concurrent syncFile calls would race for the same connection (see USB safety notes).
    for (const r of eligible) {
      if (await queueDownload(r)) done++
    }
    if (done) toast({ title: `${done} recording${done > 1 ? 's' : ''} synced` })
    return done
  }, [queueDownload])

  const cancelAllDownloads = useCallback(async () => {
    try {
      cancelDownloads()
      await window.electronAPI.downloadService.cancelAll()
      cancelDownloadsComplete()
      toast({ title: 'All downloads cancelled' })
    } catch (e) {
      cancelDownloadsComplete()
      console.error('Failed to cancel downloads:', e)
    }
  }, [])

  return {
    // Transcription
    queueTranscription,
    queueBulkTranscriptions,
    cancelTranscription,
    cancelAllTranscriptions,
    // Downloads
    queueDownload,
    queueBulkDownloads,
    cancelAllDownloads
  }
}
