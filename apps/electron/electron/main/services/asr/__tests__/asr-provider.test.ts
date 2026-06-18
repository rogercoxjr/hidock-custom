/**
 * asr-provider tests — speaker-diarization D1, Task 1.
 *
 * Verifies the AsrResult.turns extension (structural — turns optional, Turn
 * shape) and that getAsrProvider routes 'assemblyai' to createAssemblyAiAsr,
 * 'gemini'/'openai-whisper' to their factories, and THROWS on unknown
 * (no silent fallback — spec §6.2/AC9). The three factory modules are mocked
 * so this test exercises only the switch.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../gemini-asr', () => ({ createGeminiAsr: vi.fn(() => ({ transcribe: vi.fn() })) }))
vi.mock('../whisper-asr', () => ({ createWhisperAsr: vi.fn(() => ({ transcribe: vi.fn() })) }))
vi.mock('../assemblyai-asr', () => ({ createAssemblyAiAsr: vi.fn(() => ({ transcribe: vi.fn() })) }))

import { getAsrProvider, type AsrResult, type Turn } from '../asr-provider'
import { createGeminiAsr } from '../gemini-asr'
import { createWhisperAsr } from '../whisper-asr'
import { createAssemblyAiAsr } from '../assemblyai-asr'

function cfg(provider: string): never {
  return { transcription: { provider } } as never
}

describe('AsrResult.turns — structural', () => {
  it('accepts a result with structured turns (Turn shape per §6.1)', () => {
    const turn: Turn = {
      speaker: 'A',
      startMs: 0,
      endMs: 1500,
      text: 'hello',
      words: [{ text: 'hello', startMs: 0, endMs: 1500 }],
      sentiment: 'POSITIVE'
    }
    const result: AsrResult = { text: 'hello', language: 'en', turns: [turn] }
    expect(result.turns?.[0].startMs).toBe(0)
    expect(result.turns?.[0].sentiment).toBe('POSITIVE')
  })

  it('accepts a result with no turns (Whisper/Gemini stay undefined)', () => {
    const result: AsrResult = { text: 'plain' }
    expect(result.turns).toBeUndefined()
  })
})

describe('getAsrProvider — routing', () => {
  beforeEach(() => vi.clearAllMocks())

  it("routes 'assemblyai' to createAssemblyAiAsr", () => {
    getAsrProvider(cfg('assemblyai'))
    expect(createAssemblyAiAsr).toHaveBeenCalledTimes(1)
  })

  it("routes 'gemini' to createGeminiAsr", () => {
    getAsrProvider(cfg('gemini'))
    expect(createGeminiAsr).toHaveBeenCalledTimes(1)
  })

  it("routes 'openai-whisper' to createWhisperAsr", () => {
    getAsrProvider(cfg('openai-whisper'))
    expect(createWhisperAsr).toHaveBeenCalledTimes(1)
  })

  it('throws on an unknown provider — never silently falls back (AC9)', () => {
    expect(() => getAsrProvider(cfg('made-up'))).toThrow(/Unknown ASR provider/)
  })
})
