/**
 * useAudioPlayback - Manages audio playback, waveform generation, and exposes controls.
 *
 * Extracted from OperationController Phase 2+3A decomposition.
 * Owns the singleton HTMLAudioElement, Blob URL lifecycle, waveform abort controller,
 * and the window.__audioControls global registration.
 */

import { useEffect, useRef, useCallback } from 'react'
import { useUIStore } from '@/store/useUIStore'
import { toast } from '@/components/ui/toaster'
import { parseError, getErrorMessage } from '@/features/library/utils/errorHandling'
import { generateWaveformData, decodeAudioData, getAudioMimeType, getMediaUrl } from '@/utils/audioUtils'
import { shouldLogQa } from '@/services/qa-monitor'

export function useAudioPlayback() {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioBlobUrlRef = useRef<string | null>(null)
  const waveformAbortControllerRef = useRef<AbortController | null>(null)
  const playbackLockRef = useRef<Promise<void> | null>(null)
  // Monotonic token identifying the "current" playback intent. Every playAudio()
  // call and every stopAudio() bumps it. Large recordings take seconds to load,
  // leaving the play() promise pending; if the user clicks Stop / another chip
  // meanwhile, the older invocation must bail SILENTLY instead of surfacing the
  // resulting AbortError (or clobbering the newer invocation's element/state).
  const playEpochRef = useRef(0)

  const {
    setCurrentlyPlaying,
    setPlaybackProgress,
    setIsPlaying,
    setWaveformData
  } = useUIStore()

  // ---- Play Audio ----

  const playAudio = useCallback(async (recordingId: string, filePath: string, startTimeSeconds?: number) => {
    if (shouldLogQa()) console.log(`[QA-MONITOR][Operation] Playing: ${recordingId}, path: ${filePath}${startTimeSeconds ? `, startAt: ${startTimeSeconds}s` : ''}`)

    // Claim the current playback intent. Any later play()/stop() bumps this and
    // this invocation will detect it after each await and bail silently.
    const myEpoch = ++playEpochRef.current
    const superseded = () => playEpochRef.current !== myEpoch

    // Wait for any in-flight operation so heavy work doesn't overlap. If a newer
    // intent arrived while we waited, abort before doing anything.
    if (playbackLockRef.current) {
      if (shouldLogQa()) console.log('[useAudioPlayback] Waiting for previous playback operation to complete')
      try { await playbackLockRef.current } catch { /* prior op's failure is its own concern */ }
    }
    if (superseded()) return

    const thisRun = (async () => {
      try {
        // Tear down any existing element (listeners first so its teardown
        // 'emptied'/'error' events can't fire stale handlers).
        if (audioRef.current) {
          if ((audioRef.current as any)._eventCleanup) {
            ;(audioRef.current as any)._eventCleanup()
          }
          audioRef.current.pause()
          audioRef.current.src = ''
          audioRef.current = null
        }
        if (audioBlobUrlRef.current) {
          URL.revokeObjectURL(audioBlobUrlRef.current)
          audioBlobUrlRef.current = null
        }
        setIsPlaying(false)
        setPlaybackProgress(0, 0)

        // Set currently playing immediately to show loading state in UI
        setCurrentlyPlaying(recordingId, filePath)

        // Build a fresh element OWNED by this invocation. Its handlers are guarded
        // by myEpoch so a superseded element can never clobber current state.
        if (shouldLogQa()) console.log('[useAudioPlayback] Creating new Audio element (streaming)')
        const audio = new Audio()

        const handleTimeUpdate = () => {
          if (superseded()) return
          setPlaybackProgress(audio.currentTime, audio.duration)
        }
        const handlePlay = () => {
          if (superseded()) return
          if (shouldLogQa()) console.log('[QA-MONITOR][Operation] Audio play event fired')
          setIsPlaying(true)
        }
        const handlePause = () => {
          if (superseded()) return
          setIsPlaying(false)
        }
        const handleEnded = () => {
          if (superseded()) return
          setIsPlaying(false)
          setCurrentlyPlaying(null, null)
          setPlaybackProgress(0, 0)
          setWaveformData(null)
        }
        const handleError = (e: ErrorEvent) => {
          // Ignore errors from a superseded element (e.g. src='' teardown).
          if (superseded()) return
          const mediaError = audio.error
          console.error('[useAudioPlayback] Audio element error:', {
            code: mediaError?.code,
            message: mediaError?.message,
            event: e
          })
          const libraryError = parseError(e, 'audio playback')
          toast({
            title: 'Playback error',
            description: getErrorMessage(libraryError.type),
            variant: 'error'
          })
          setIsPlaying(false)
          setCurrentlyPlaying(null, null)
          setWaveformData(null)
        }

        audio.addEventListener('timeupdate', handleTimeUpdate)
        audio.addEventListener('play', handlePlay)
        audio.addEventListener('pause', handlePause)
        audio.addEventListener('ended', handleEnded)
        audio.addEventListener('error', handleError)
        ;(audio as any)._eventCleanup = () => {
          audio.removeEventListener('timeupdate', handleTimeUpdate)
          audio.removeEventListener('play', handlePlay)
          audio.removeEventListener('pause', handlePause)
          audio.removeEventListener('ended', handleEnded)
          audio.removeEventListener('error', handleError)
        }

        if (superseded()) return // a newer play/stop took over; don't commit
        audioRef.current = audio

        // Stream the recording via the custom `hidock-media` protocol instead of
        // loading the whole (often 300+ MB) file as base64 over IPC. The <audio>
        // element fetches only the bytes it needs and seeking issues HTTP Range
        // requests, so playback starts near-instantly and never blocks the UI.
        const mediaUrl = getMediaUrl(filePath)
        if (shouldLogQa()) console.log(`[QA-MONITOR][Operation] Setting audio src (stream): ${mediaUrl}`)
        audio.src = mediaUrl

        // Seek-after-load: a `seek()` fired immediately after `play()` is dropped
        // because the element's metadata (duration / seekable range) isn't ready yet
        // and `currentTime` can't be set reliably until then. When a start offset is
        // requested, apply it once metadata is available (or immediately if already
        // loaded) so the playhead lands at the requested turn before/at play start.
        if (startTimeSeconds && startTimeSeconds > 0) {
          const applyStart = () => {
            if (audioRef.current === audio && !superseded()) {
              try {
                audio.currentTime = startTimeSeconds
              } catch {
                // Ignore: out-of-range seeks settle to a valid position on play.
              }
            }
          }
          if (audio.readyState >= 1 /* HAVE_METADATA */) {
            applyStart()
          } else {
            audio.addEventListener('loadedmetadata', applyStart, { once: true })
          }
        }

        if (shouldLogQa()) console.log('[QA-MONITOR][Operation] Calling audio.play()')
        await audio.play()
        if (shouldLogQa()) console.log('[QA-MONITOR][Operation] audio.play() resolved successfully')

        // Generate the waveform in the background (non-blocking) so playback is
        // never gated on decoding the whole file. Skipped when already loaded for
        // this recording; loadWaveformOnly itself skips files >100MB. Invoked via
        // the global control to avoid a render-time circular dependency between
        // playAudio and loadWaveformOnly.
        if (useUIStore.getState().waveformLoadedForId !== recordingId) {
          window.__audioControls?.loadWaveformOnly?.(recordingId, filePath)
        }
      } catch (error) {
        // AbortError is the EXPECTED result when a newer play()/stop() interrupts a
        // pending play() (large files keep it pending for seconds). It is not a real
        // failure — never surface it, and don't touch state the newer intent owns.
        const name = (error as { name?: string })?.name
        if (name === 'AbortError' || superseded()) {
          if (shouldLogQa()) console.log('[useAudioPlayback] Playback superseded/aborted (benign)')
          return
        }
        const libraryError = parseError(error, 'audio playback')
        console.error('[useAudioPlayback] Play error:', error)
        toast({
          title: 'Playback error',
          description: getErrorMessage(libraryError.type),
          variant: 'error'
        })
        setIsPlaying(false)
        setCurrentlyPlaying(null, null)
        setWaveformData(null)
      } finally {
        // Release the lock only if we're still the current intent. If superseded,
        // the newer invocation (currently awaiting this promise) will install its
        // own lock once we resolve.
        if (!superseded()) playbackLockRef.current = null
      }
    })()

    playbackLockRef.current = thisRun
    return thisRun
  }, [setCurrentlyPlaying, setPlaybackProgress, setIsPlaying, setWaveformData])

  // ---- Waveform-Only Load ----

  const loadWaveformOnly = useCallback(async (recordingId: string, filePath: string) => {
    if (shouldLogQa()) console.log(`[QA-MONITOR][Operation] Loading waveform only: ${recordingId}`)

    // Cancel any in-flight waveform loading
    if (waveformAbortControllerRef.current) {
      waveformAbortControllerRef.current.abort()
    }

    waveformAbortControllerRef.current = new AbortController()
    const signal = waveformAbortControllerRef.current.signal

    const { setWaveformLoading, setWaveformLoadingError, setWaveformLoadedFor, setWaveformData } = useUIStore.getState()
    setWaveformLoading(recordingId)

    try {
      if (signal.aborted) {
        if (shouldLogQa()) console.log('[useAudioPlayback] Waveform load aborted (early)')
        return
      }

      const response = await window.electronAPI.storage.readRecording(filePath)

      if (!response.success || !response.data) {
        throw new Error(response.error || 'Failed to read audio file')
      }

      const base64 = response.data
      const fileSizeBytes = Math.ceil((base64.length * 3) / 4)

      const MAX_FILE_SIZE = 100 * 1024 * 1024 // 100MB
      if (fileSizeBytes > MAX_FILE_SIZE) {
        throw new Error(`File too large (${Math.round(fileSizeBytes / (1024 * 1024))}MB). Maximum size is 100MB.`)
      }

      if (signal.aborted) return

      const mimeType = getAudioMimeType(filePath)
      const audioBuffer = await decodeAudioData(base64, mimeType)

      if (signal.aborted) return

      const waveformData = await generateWaveformData(audioBuffer, 1000)

      if (signal.aborted) return

      setWaveformData(waveformData)
      setWaveformLoadedFor(recordingId)

      if (shouldLogQa()) console.log(`[QA-MONITOR][Operation] Waveform loaded successfully: ${recordingId}`)
    } catch (error) {
      if (signal.aborted) return

      const libraryError = parseError(error, 'waveform generation')
      console.error('[useAudioPlayback] Waveform load error:', error)

      setWaveformLoadingError(recordingId, getErrorMessage(libraryError.type))
      setWaveformData(null)
    }
  }, [])

  // ---- Simple Controls ----

  const pauseAudio = useCallback(() => {
    if (audioRef.current) audioRef.current.pause()
  }, [])

  const resumeAudio = useCallback(() => {
    if (audioRef.current) audioRef.current.play()
  }, [])

  const stopAudio = useCallback(() => {
    // Supersede any in-flight play() so its pending promise resolves to a silent
    // bail instead of an AbortError toast.
    playEpochRef.current++
    if (audioRef.current) {
      // Clean up event listeners when stopping
      if ((audioRef.current as any)._eventCleanup) {
        ;(audioRef.current as any)._eventCleanup()
      }
      audioRef.current.pause()
      audioRef.current.src = ''
      audioRef.current = null // Clear the ref to allow recreation with fresh listeners
    }
    if (audioBlobUrlRef.current) {
      URL.revokeObjectURL(audioBlobUrlRef.current)
      audioBlobUrlRef.current = null
    }
    setIsPlaying(false)
    setCurrentlyPlaying(null, null)
    setPlaybackProgress(0, 0)
    setWaveformData(null)
  }, [setCurrentlyPlaying, setIsPlaying, setPlaybackProgress, setWaveformData])

  const seekAudio = useCallback((time: number) => {
    if (audioRef.current) audioRef.current.currentTime = time
  }, [])

  const setPlaybackRate = useCallback((rate: number) => {
    if (audioRef.current) audioRef.current.playbackRate = rate
  }, [])

  // ---- Expose controls globally via window.__audioControls ----

  useEffect(() => {
    window.__audioControls = {
      play: playAudio,
      pause: pauseAudio,
      resume: resumeAudio,
      stop: stopAudio,
      seek: seekAudio,
      setPlaybackRate,
      loadWaveformOnly
    }

    return () => {
      delete window.__audioControls
    }
  }, [playAudio, pauseAudio, resumeAudio, stopAudio, seekAudio, setPlaybackRate, loadWaveformOnly])

  // ---- Cleanup on unmount ----

  useEffect(() => {
    return () => {
      // Clean up audio element
      if (audioRef.current) {
        // Remove event listeners first to prevent memory leaks
        if ((audioRef.current as any)._eventCleanup) {
          ;(audioRef.current as any)._eventCleanup()
        }
        audioRef.current.pause()
        audioRef.current.src = ''
      }
      // Clean up blob URL
      if (audioBlobUrlRef.current) {
        URL.revokeObjectURL(audioBlobUrlRef.current)
        audioBlobUrlRef.current = null
      }
      // Abort any in-flight waveform generation
      if (waveformAbortControllerRef.current) {
        waveformAbortControllerRef.current.abort()
      }
    }
  }, [])
}
