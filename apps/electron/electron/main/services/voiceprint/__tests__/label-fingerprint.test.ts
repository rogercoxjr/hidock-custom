import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/fake', getAppPath: () => '/fake/app', isPackaged: false },
}))

import { labelTurnsFingerprint, WINDOW_SLICE_PARAMS } from '../speaker-matcher'
import type { Turn } from '../../asr/asr-provider'

const turn = (speaker: string, startMs: number, endMs: number): Turn => ({
  speaker, startMs, endMs, text: 'x',
})

describe('labelTurnsFingerprint', () => {
  it('is stable across call order and ignores other labels', () => {
    const t1: Turn[] = [turn('A', 0, 1000), turn('B', 1000, 2000), turn('A', 3000, 4000)]
    const t2: Turn[] = [turn('A', 3000, 4000), turn('B', 9000, 9999), turn('A', 0, 1000)]
    expect(labelTurnsFingerprint(t1, 'A', 'm', 1)).toBe(labelTurnsFingerprint(t2, 'A', 'm', 1))
  })

  it('changes when the label gains/loses a turn (per-turn reassign)', () => {
    const before: Turn[] = [turn('A', 0, 1000), turn('B', 1000, 2000)]
    const after: Turn[] = [turn('A', 0, 1000), turn('A', 1000, 2000)] // B's turn reassigned to A
    expect(labelTurnsFingerprint(before, 'A', 'm', 1)).not.toBe(labelTurnsFingerprint(after, 'A', 'm', 1))
  })

  it('changes when model id or version changes', () => {
    const t: Turn[] = [turn('A', 0, 1000)]
    expect(labelTurnsFingerprint(t, 'A', 'm', 1)).not.toBe(labelTurnsFingerprint(t, 'A', 'm2', 1))
    expect(labelTurnsFingerprint(t, 'A', 'm', 1)).not.toBe(labelTurnsFingerprint(t, 'A', 'm', 2))
  })

  it('exposes the slicing params that match sliceLabelWindows defaults', () => {
    expect(WINDOW_SLICE_PARAMS).toEqual({ windowMs: 20_000, hopMs: 10_000 })
  })
})

describe('VOICEPRINT_MODEL_VERSION', () => {
  it('is the single declared model version (1)', async () => {
    const vp = await import('../../voiceprint-service')
    expect(vp.VOICEPRINT_MODEL_VERSION).toBe(1)
  })
})
