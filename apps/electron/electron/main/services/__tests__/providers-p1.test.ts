/**
 * Provider-layer tests (auto-pipeline P1, Task 3).
 *
 * Covers the Gemini-only ASR and LLM provider factories extracted from
 * transcription.ts. Asserts the canonical key-missing string, the inline
 * base64 + meeting-context audio call shape, and pass-through text generation.
 *
 * @vitest-environment node
 */

// Mocks must be defined BEFORE the modules under test are imported.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Capturable generateContent mock. The factories call `new GoogleGenerativeAI(...)`
// directly, so the mock must be a real (newable) class — same idiom as
// e2e-smoke.test.ts. mockGenerateContent is hoisted via vi.hoisted so the class
// (also hoisted by vi.mock) can close over it, and individual tests can drive it.
const { mockGenerateContent } = vi.hoisted(() => ({ mockGenerateContent: vi.fn() }))

vi.mock('@google/generative-ai', () => {
  class GoogleGenerativeAI {
    getGenerativeModel() {
      return { generateContent: (...args: unknown[]) => mockGenerateContent(...args) }
    }
  }
  return { GoogleGenerativeAI }
})

import { getAsrProvider } from '../asr/asr-provider'
import { getLlmProvider } from '../llm/llm-provider'

// Narrow test double of AppConfig — only the fields the factories read.
const geminiConfig = {
  transcription: { provider: 'gemini', geminiApiKey: 'k', geminiModel: 'gemini-2.0-flash-exp', autoTranscribe: true }
} as never

// Real temp audio file so gemini-asr's promisified readFile works.
let tempAudioPath: string
let tempDir: string

beforeEach(() => {
  vi.clearAllMocks()
  tempDir = mkdtempSync(join(tmpdir(), 'providers-p1-'))
  tempAudioPath = join(tempDir, 'audio.wav')
  writeFileSync(tempAudioPath, Buffer.alloc(16))
})

describe('getAsrProvider (P1: gemini only)', () => {
  it('throws the canonical message when the key is missing', () => {
    const noKey = { transcription: { provider: 'gemini', geminiApiKey: '', geminiModel: 'm' } } as never
    expect(() => getAsrProvider(noKey)).toThrow('Gemini API key not configured')
  })

  it('transcribe() sends inline base64 + meeting context and returns { text }', async () => {
    mockGenerateContent.mockResolvedValueOnce({ response: { text: () => 'TRANSCRIBED' } })
    const asr = getAsrProvider(geminiConfig)
    const result = await asr.transcribe(tempAudioPath, { meetingContext: '\nCTX' })
    expect(result.text).toBe('TRANSCRIBED')
    expect(result.language).toBeUndefined() // gemini-asr supplies no language (spec §5.3)
    const callArg = mockGenerateContent.mock.calls[0][0]
    expect(JSON.stringify(callArg)).toContain('inlineData')
    expect(JSON.stringify(callArg)).toContain('CTX')
  })
})

describe('getLlmProvider (P1: gemini only)', () => {
  it('throws the canonical message when the key is missing', () => {
    const noKey = {
      transcription: { provider: 'gemini', geminiApiKey: '', geminiModel: 'm' },
      summarization: undefined
    } as never
    expect(() => getLlmProvider(noKey)).toThrow('Gemini API key not configured')
  })

  it('generate() returns the response text', async () => {
    mockGenerateContent.mockResolvedValueOnce({ response: { text: () => '{"summary":"s"}' } })
    const llm = getLlmProvider(geminiConfig)
    const out = await llm.generate('PROMPT', { json: true })
    expect(out).toBe('{"summary":"s"}')
    expect(mockGenerateContent).toHaveBeenCalledWith('PROMPT')
  })
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})
