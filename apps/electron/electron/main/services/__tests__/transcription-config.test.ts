/**
 * transcription-config tests — verifies the provider-aware key preflight
 * (spec §5.6) extracted from recording-handlers.ts in plan 0f so the hosted
 * server can import it without pulling electron into a plain-Node graph.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Controllable config returned by the mocked getConfig().
const cfg = vi.hoisted(() => ({
  value: {} as Record<string, unknown>
}))

vi.mock('../config', () => ({
  getConfig: () => cfg.value
}))

import { validateTranscriptionConfig } from '../transcription-config'

function baseConfig(over: Record<string, unknown> = {}) {
  return {
    transcription: {
      provider: 'openai-whisper',
      openaiApiKey: 'sk-present',
      geminiApiKey: 'g-present',
      assemblyaiApiKey: 'a-present'
    },
    summarization: { provider: 'gemini' },
    ...over
  }
}

describe('validateTranscriptionConfig', () => {
  beforeEach(() => {
    cfg.value = baseConfig()
  })

  it('ok=true when the selected providers all have keys', () => {
    const r = validateTranscriptionConfig()
    expect(r.ok).toBe(true)
    expect(r.problems).toEqual([])
  })

  it('flags a missing whisper key', () => {
    cfg.value = baseConfig({
      transcription: { provider: 'openai-whisper', openaiApiKey: '   ', geminiApiKey: 'g', assemblyaiApiKey: 'a' }
    })
    const r = validateTranscriptionConfig()
    expect(r.ok).toBe(false)
    expect(r.problems).toContainEqual({ stage: 'asr', provider: 'openai-whisper', problem: 'missing-key' })
  })

  it('flags a missing summarization gemini key without duplicating an asr gemini problem', () => {
    cfg.value = baseConfig({
      transcription: { provider: 'gemini', openaiApiKey: '', geminiApiKey: '', assemblyaiApiKey: '' },
      summarization: { provider: 'gemini' }
    })
    const r = validateTranscriptionConfig()
    const geminiProblems = r.problems.filter((p) => p.provider === 'gemini')
    expect(geminiProblems).toHaveLength(1)
    expect(geminiProblems[0].stage).toBe('asr')
  })

  it('flags a missing ollama-cloud summarization key', () => {
    cfg.value = baseConfig({ summarization: { provider: 'ollama-cloud', ollamaCloudApiKey: '' } })
    const r = validateTranscriptionConfig()
    expect(r.problems).toContainEqual({ stage: 'summarization', provider: 'ollama-cloud', problem: 'missing-key' })
  })
})
