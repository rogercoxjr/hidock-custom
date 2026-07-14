/**
 * useDataFreshnessBridge.test.ts — the central WS/IPC-event → freshness-bus mapping.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const emitFreshness = vi.fn()
vi.mock('@/lib/dataFreshness', () => ({
  emitFreshness: (...args: unknown[]) => emitFreshness(...args),
  ALL_TOPICS: ['recordings', 'actionables', 'projects'] as const,
}))

import { useDataFreshnessBridge } from '../useDataFreshnessBridge'

type Handlers = {
  recordingAdded?: (data: unknown) => void
  txCompleted?: (data: unknown) => void
  txFailed?: (data: unknown) => void
  dlState?: (state: unknown) => void
  reconnect?: () => void
}

function setupApi(): Handlers {
  const h: Handlers = {}
  ;(window as any).electronAPI = {
    onRecordingAdded: vi.fn((cb: any) => {
      h.recordingAdded = cb
      return () => {}
    }),
    onTranscriptionCompleted: vi.fn((cb: any) => {
      h.txCompleted = cb
      return () => {}
    }),
    onTranscriptionFailed: vi.fn((cb: any) => {
      h.txFailed = cb
      return () => {}
    }),
    downloadService: {
      onStateUpdate: vi.fn((cb: any) => {
        h.dlState = cb
        return () => {}
      }),
    },
    onConnectionRestored: vi.fn((cb: any) => {
      h.reconnect = cb
      return () => {}
    }),
  }
  return h
}

describe('useDataFreshnessBridge', () => {
  beforeEach(() => {
    emitFreshness.mockClear()
    delete (window as any).electronAPI
  })

  it('maps a completed transcription to recordings + actionables + projects', () => {
    const h = setupApi()
    renderHook(() => useDataFreshnessBridge())

    h.txCompleted!({ recordingId: 'r1' })

    const topics = emitFreshness.mock.calls.map((c) => c[0])
    expect(topics).toContain('recordings')
    expect(topics).toContain('actionables')
    expect(topics).toContain('projects')
  })

  it('maps recording:new and transcription failure to recordings only', () => {
    const h = setupApi()
    renderHook(() => useDataFreshnessBridge())

    h.recordingAdded!({ recording: {} })
    h.txFailed!({ recordingId: 'r1', error: 'boom' })

    const topics = emitFreshness.mock.calls.map((c) => c[0])
    expect(topics.filter((t) => t === 'recordings')).toHaveLength(2)
    expect(topics).not.toContain('actionables')
    expect(topics).not.toContain('projects')
  })

  it('edge-triggers recordings only when the completed-download count increases', () => {
    const h = setupApi()
    renderHook(() => useDataFreshnessBridge())

    h.dlState!({ queue: [{ status: 'downloading' }] }) // 0 completed
    expect(emitFreshness).not.toHaveBeenCalled()

    h.dlState!({ queue: [{ status: 'completed' }] }) // 0 → 1
    expect(emitFreshness).toHaveBeenCalledWith('recordings')

    emitFreshness.mockClear()
    h.dlState!({ queue: [{ status: 'completed' }] }) // 1 → 1, no change
    expect(emitFreshness).not.toHaveBeenCalled()
  })

  it('refetches all topics on WS reconnect', () => {
    const h = setupApi()
    renderHook(() => useDataFreshnessBridge())

    h.reconnect!()

    const topics = emitFreshness.mock.calls.map((c) => c[0])
    expect(topics).toEqual(expect.arrayContaining(['recordings', 'actionables', 'projects']))
  })

  it('no-ops safely when electronAPI is absent (non-electron context)', () => {
    expect(() => renderHook(() => useDataFreshnessBridge())).not.toThrow()
    expect(emitFreshness).not.toHaveBeenCalled()
  })
})
