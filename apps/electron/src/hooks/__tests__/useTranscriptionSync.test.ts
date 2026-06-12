/**
 * Tests for useTranscriptionSync — the 5 s poll reconcile of the renderer-side
 * transcription store against the DB queue (auto-pipeline P4 Task 4).
 *
 * Focus: the poll's 'pending' branch must reconcile a store row that is still
 * 'failed' (e.g. after Retry-all flips the DB row failed→pending) back to
 * 'pending', so the failure chip clears. Previously the branch only ADDED
 * missing items and never reset the status of an item already in the store.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useTranscriptionSync } from '@/hooks/useTranscriptionSync'
import { useTranscriptionStore } from '@/store/features/useTranscriptionStore'

function setQueue(items: any[]) {
  ;(window.electronAPI.recordings.getTranscriptionQueue as any) = vi.fn().mockResolvedValue(items)
}

beforeEach(() => {
  vi.useFakeTimers()
  useTranscriptionStore.getState().clear()
  ;(window as any).electronAPI = {
    recordings: {
      getTranscriptionQueue: vi.fn().mockResolvedValue([])
    }
  }
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useTranscriptionSync — poll reconcile (auto-pipeline P4 Task 4)', () => {
  it('resets a store row from failed→pending when the DB now reports it pending', async () => {
    // Mount-hydration sees the row as pending and adds it as pending.
    setQueue([{ id: 'q-1', recording_id: 'rec-1', filename: 'a.wav', status: 'pending' }])
    renderHook(() => useTranscriptionSync())
    // Flush the mount hydration .then() so q-1 is in the store as 'pending'.
    await vi.advanceTimersByTimeAsync(0)
    expect(useTranscriptionStore.getState().queue.get('q-1')?.status).toBe('pending')

    // Now simulate a live transcription:failed event marking the SAME row failed
    // (the store row exists and is 'failed' — the exact state the old poll ignored).
    useTranscriptionStore.getState().markFailed('q-1', 'OpenAI API key was rejected')
    expect(useTranscriptionStore.getState().queue.get('q-1')?.status).toBe('failed')

    // DB still reports the row pending (Retry-all flipped it / it never actually
    // failed in the DB). The next poll must reconcile the failed store row → pending.
    await vi.advanceTimersByTimeAsync(5000)

    const item = useTranscriptionStore.getState().queue.get('q-1')
    expect(item).toBeTruthy()
    expect(item?.status).toBe('pending')
    expect(item?.error).toBeUndefined()
  })

  it('adds a brand-new pending DB row that is absent from the store', async () => {
    setQueue([{ id: 'q-2', recording_id: 'rec-2', filename: 'b.wav', status: 'pending' }])

    renderHook(() => useTranscriptionSync())
    await vi.advanceTimersByTimeAsync(5000)

    const item = useTranscriptionStore.getState().queue.get('q-2')
    expect(item?.status).toBe('pending')
  })

  it('leaves an already-pending store row untouched (no churn)', async () => {
    const store = useTranscriptionStore.getState()
    store.addToQueue('q-3', 'rec-3', 'c.wav') // starts pending
    setQueue([{ id: 'q-3', recording_id: 'rec-3', filename: 'c.wav', status: 'pending' }])

    renderHook(() => useTranscriptionSync())
    await vi.advanceTimersByTimeAsync(5000)

    expect(useTranscriptionStore.getState().queue.get('q-3')?.status).toBe('pending')
  })
})
