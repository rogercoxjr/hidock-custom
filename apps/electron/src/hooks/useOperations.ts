import { useCallback } from 'react'
import { toast } from '@/components/ui/toaster'
import { useTranscriptionStore } from '@/store/features/useTranscriptionStore'
import { cancelDownloads, cancelDownloadsComplete } from '@/hooks/useDownloadOrchestrator'
import { beginDownload, endDownload } from '@/services/download-guard'
import type { UnifiedRecording } from '@/types/unified-recording'
import { hasLocalPath, isDeviceOnly } from '@/types/unified-recording'
import type { ElectronAPI } from '@/lib/electron-api/types'

// Task 12 investigated reconciling this: window.electronAPI's *ambient* type is sourced from
// the real Electron desktop preload's ElectronAPI (electron/preload/index.ts), whose object
// literal (`const electronAPI: ElectronAPI = {...}`, backed by ipcRenderer IPC to a
// main-process implementation over the native `usb` package) is checked structurally against
// the interface. Adding `deviceSync` / `downloadService.deviceFileSource` as required members
// there forced tsc to demand real implementations in that object literal too (confirmed:
// `tsc` failed with "Property 'deviceFileSource' is missing" once added) — but desktop mode
// has no way to back them: its `jensen`/`downloadService` live in the main process via
// native-USB IPC, entirely separate from the renderer-side WebUSB `getJensenDevice()`
// singleton the hosted REST facade uses. Stubbing them to compile would silently lie about
// desktop capability, so the reconciliation was judged too risky per Task 12's brief and left
// for a dedicated task. `deviceSync` / `downloadService.deviceFileSource` are hosted-mode-only
// REST facade members — composed onto `window.electronAPI` at runtime by `installRestApi()`
// (src/lib/electron-api/index.ts) and typed on the renderer's own `ElectronAPI` in
// src/lib/electron-api/types.ts. This narrow cast bridges the gap for hosted mode without
// widening the desktop ambient global. Read fresh on every call (not cached at module scope)
// so tests that reassign `window.electronAPI` per-case still see the current mock.
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

    // Raise the download guard so concurrent listFiles/refresh/reconnect don't cancel the read
    // (see download-guard.ts). Ref-counted, so nesting under queueBulkDownloads is safe.
    beginDownload()
    try {
      const src = hostedApi().downloadService.deviceFileSource(recording.deviceFilename, recording.size)
      const res = await hostedApi().deviceSync.syncFile(src)
      toast({ title: res.status === 'skipped' ? 'Already synced' : 'Synced', description: recording.filename })
      return true
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error'
      toast({ title: 'Sync failed', description: msg, variant: 'error' })
      return false
    } finally {
      endDownload()
    }
  }, [])

  const queueBulkDownloads = useCallback(async (recordings: UnifiedRecording[]) => {
    const eligible = recordings.filter(isDeviceOnly)
    // Hold the guard across the WHOLE batch (not just each file) so a refresh can't slip in
    // between files and cancel the next download's read. Ref-counted with the per-file
    // queueDownload begin/end, so the guard stays raised until the last file settles.
    beginDownload()
    try {
      let done = 0
      // Serialized — one device claim at a time. The device has a single USB endpoint, so
      // concurrent syncFile calls would race for the same connection (see USB safety notes).
      for (const r of eligible) {
        if (await queueDownload(r)) done++
      }
      if (done) toast({ title: `${done} recording${done > 1 ? 's' : ''} synced` })
      return done
    } finally {
      endDownload()
    }
  }, [queueDownload])

  // Same hosted device-sync client as queueDownload/queueBulkDownloads above, but takes
  // raw {filename, size} pairs (e.g. from downloadService.getFilesToSync) rather than
  // UnifiedRecording objects — used by the /sync page's "Sync all" flow (Device.tsx).
  const syncDeviceFiles = useCallback(async (files: Array<{ filename: string; size: number }>) => {
    // Hold the guard for the whole batch so concurrent listFiles/refresh/reconnect can't cancel
    // an in-flight read (see download-guard.ts).
    beginDownload()
    try {
      let synced = 0
      // Serialized — one device claim at a time (see queueBulkDownloads USB safety notes).
      for (const f of files) {
        try {
          const src = hostedApi().downloadService.deviceFileSource(f.filename, f.size)
          await hostedApi().deviceSync.syncFile(src)
          synced++
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'Unknown error'
          console.error('Failed to sync device file:', f.filename, msg)
        }
      }
      return synced
    } finally {
      endDownload()
    }
  }, [])

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
    syncDeviceFiles,
    cancelAllDownloads
  }
}
