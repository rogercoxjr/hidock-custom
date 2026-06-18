/**
 * voiceprint-service tests — speaker-diarization D4 (spec §6.7, AC4).
 *
 * Capture-only hook. sherpa-onnx-node, ffmpeg (child_process), fs, electron,
 * and ../database are all mocked — no real addon, no real ffmpeg, no device.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Hoisted controllable state — resolves before vi.mock factories run.
const shared = vi.hoisted(() => ({
  sherpaThrows: false as boolean,
  extractorDim: 256 as number,
  computeResult: null as Float32Array | null
}))

// Mock: sherpa-onnx-node — a SpeakerEmbeddingExtractor whose ctor can throw.
vi.mock('sherpa-onnx-node', () => {
  class SpeakerEmbeddingExtractor {
    dim = shared.extractorDim
    constructor() {
      if (shared.sherpaThrows) throw new Error('addon load failed')
    }
    createStream() {
      return {}
    }
    acceptWaveform() {}
    isReady() {
      return true
    }
    compute() {
      return shared.computeResult ?? new Float32Array(shared.extractorDim)
    }
  }
  return { SpeakerEmbeddingExtractor }
})

import { isVoiceprintAvailable } from '../voiceprint-service'

beforeEach(() => {
  shared.sherpaThrows = false
  shared.extractorDim = 256
  shared.computeResult = null
  vi.clearAllMocks()
})

describe('voiceprint-service load (§6.7, AC4)', () => {
  it('1. isVoiceprintAvailable() is true when sherpa-onnx-node loads', () => {
    expect(isVoiceprintAvailable()).toBe(true)
  })

  it('2. isVoiceprintAvailable() is false when sherpa-onnx-node is missing', async () => {
    vi.resetModules()
    vi.doMock('sherpa-onnx-node', () => {
      throw new Error('Cannot find module sherpa-onnx-node')
    })
    try {
      const { isVoiceprintAvailable: probe } = await import('../voiceprint-service')
      expect(probe()).toBe(false)
    } finally {
      vi.doUnmock('sherpa-onnx-node')
      vi.resetModules()
    }
  })
})
