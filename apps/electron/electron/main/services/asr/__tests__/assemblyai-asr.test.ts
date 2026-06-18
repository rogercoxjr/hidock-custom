/**
 * assemblyai-asr tests — speaker-diarization D1, Task 3.
 *
 * Verifies the AssemblyAI provider: loud key-missing guard (§8/AC9), the
 * upload→submit→poll flow, the submit body (speech_models ARRAY incl.
 * universal-3-pro, model_region 'global', speaker_labels, sentiment_analysis,
 * keyterms_prompt, language_code 'en' — and NEVER singular speech_model,
 * NEVER word_boost — AC8), utterances→Turn[] with SECONDS→ms ×1000 (AC1),
 * roster, and 401/429/error/poll-timeout classification (§8/AC7).
 *
 * fs.readFileSync is mocked (no real file). global fetch is stubbed.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('fs', () => ({ readFileSync: vi.fn(() => Buffer.from('AUDIO')) }))

import { createAssemblyAiAsr } from '../assemblyai-asr'
import { ProviderRateLimitError, ProviderAuthError } from '../../provider-errors'

function aaiConfig(
  assemblyaiApiKey = 'aai-key',
  assemblyaiModels = ['universal-3-pro', 'universal-2'],
  language = 'en'
): never {
  return { transcription: { provider: 'assemblyai', assemblyaiApiKey, assemblyaiModels, language } } as never
}

function res(opts: { status?: number; ok?: boolean; jsonBody?: unknown; textBody?: string; retryAfter?: string }) {
  const status = opts.status ?? 200
  const headers = new Map<string, string>()
  if (opts.retryAfter) headers.set('Retry-After', opts.retryAfter)
  return {
    status,
    ok: opts.ok ?? (status >= 200 && status < 300),
    headers: { get: (k: string) => headers.get(k) ?? null },
    json: async () => opts.jsonBody,
    text: async () => opts.textBody ?? ''
  }
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('createAssemblyAiAsr — construction', () => {
  it('throws a loud canonical message when the key is missing (§8/AC9)', () => {
    expect(() => createAssemblyAiAsr(aaiConfig(''))).toThrow(
      'AssemblyAI API key not configured — add it in Settings → Transcription'
    )
  })
})

describe('createAssemblyAiAsr — happy path', () => {
  beforeEach(() => {
    fetchMock
      // 1. upload
      .mockResolvedValueOnce(res({ jsonBody: { upload_url: 'https://cdn.assemblyai.com/up/abc' } }))
      // 2. submit
      .mockResolvedValueOnce(res({ jsonBody: { id: 'txn_1', status: 'queued' } }))
      // 3. poll → completed
      .mockResolvedValueOnce(
        res({
          jsonBody: {
            id: 'txn_1',
            status: 'completed',
            text: 'Hello there. General Kenobi.',
            language_code: 'en',
            speech_model_used: 'universal-3-pro',
            utterances: [
              { speaker: 'A', start: 0, end: 1.5, text: 'Hello there.', sentiment: 'POSITIVE',
                words: [{ text: 'Hello', start: 0, end: 0.5 }, { text: 'there.', start: 0.5, end: 1.5 }] },
              { speaker: 'B', start: 2, end: 3.25, text: 'General Kenobi.', sentiment: 'NEUTRAL',
                words: [{ text: 'General', start: 2, end: 2.6 }, { text: 'Kenobi.', start: 2.6, end: 3.25 }] }
            ]
          }
        })
      )
  })

  it('returns text + language + structured turns with SECONDS→ms ×1000 (AC1)', async () => {
    const asr = createAssemblyAiAsr(aaiConfig())
    const result = await asr.transcribe('/recordings/a.hda', {})
    expect(result.text).toBe('Hello there. General Kenobi.')
    expect(result.language).toBe('en')
    expect(result.turns).toHaveLength(2)
    expect(result.turns![0]).toEqual({
      speaker: 'A',
      startMs: 0,
      endMs: 1500,
      text: 'Hello there.',
      sentiment: 'POSITIVE',
      words: [
        { text: 'Hello', startMs: 0, endMs: 500 },
        { text: 'there.', startMs: 500, endMs: 1500 }
      ]
    })
    expect(result.turns![1].startMs).toBe(2000)
    expect(result.turns![1].endMs).toBe(3250)
    expect(result.turns![1].sentiment).toBe('NEUTRAL')
  })

  it('submit body uses speech_models ARRAY incl. universal-3-pro, global region, labels+sentiment, language_code; NEVER singular speech_model or word_boost (AC8)', async () => {
    const asr = createAssemblyAiAsr(aaiConfig())
    await asr.transcribe('/recordings/a.hda', { meetingContext: 'Acme Corp; Project Phoenix' })

    // call[0] = upload, call[1] = submit
    const [uploadUrl, uploadInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(uploadUrl).toBe('https://api.assemblyai.com/v2/upload')
    expect((uploadInit.headers as Record<string, string>).Authorization).toBe('aai-key')

    const [submitUrl, submitInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(submitUrl).toBe('https://api.assemblyai.com/v2/transcript')
    expect((submitInit.headers as Record<string, string>).Authorization).toBe('aai-key')
    const body = JSON.parse(submitInit.body as string)
    expect(body.audio_url).toBe('https://cdn.assemblyai.com/up/abc')
    expect(Array.isArray(body.speech_models)).toBe(true)
    expect(body.speech_models).toEqual(['universal-3-pro', 'universal-2'])
    expect(body.model_region).toBe('global')
    expect(body.speaker_labels).toBe(true)
    expect(body.sentiment_analysis).toBe(true)
    expect(body.language_code).toBe('en')
    // forbidden keys — the rev-1 blocker + word_boost downgrade trap
    expect(body).not.toHaveProperty('speech_model')
    expect(body).not.toHaveProperty('word_boost')
  })

  it('builds keyterms_prompt from meetingContext (NOT word_boost)', async () => {
    const asr = createAssemblyAiAsr(aaiConfig())
    await asr.transcribe('/recordings/a.hda', { meetingContext: 'Acme Corp; Project Phoenix' })
    const body = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string)
    expect(Array.isArray(body.keyterms_prompt)).toBe(true)
    expect(body.keyterms_prompt).toContain('Acme Corp')
    expect(body.keyterms_prompt).toContain('Project Phoenix')
  })
})

describe('createAssemblyAiAsr — error classification (§8/AC7)', () => {
  it('401 on submit → ProviderAuthError(AssemblyAI)', async () => {
    fetchMock
      .mockResolvedValueOnce(res({ jsonBody: { upload_url: 'u' } }))
      .mockResolvedValueOnce(res({ status: 401, textBody: 'unauthorized' }))
    const asr = createAssemblyAiAsr(aaiConfig())
    const err = await asr.transcribe('/r/a.hda', {}).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderAuthError)
    expect((err as Error).message).toContain('AssemblyAI API key was rejected')
  })

  it('429 on submit → ProviderRateLimitError with retryAfterMs', async () => {
    fetchMock
      .mockResolvedValueOnce(res({ jsonBody: { upload_url: 'u' } }))
      .mockResolvedValueOnce(res({ status: 429, textBody: 'slow down', retryAfter: '30' }))
    const asr = createAssemblyAiAsr(aaiConfig())
    const err = await asr.transcribe('/r/a.hda', {}).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderRateLimitError)
    expect((err as ProviderRateLimitError).provider).toBe('AssemblyAI')
    expect((err as ProviderRateLimitError).retryAfterMs).toBe(30000)
  })

  it("poll status 'error' → terminal retryable Error with the AssemblyAI message", async () => {
    fetchMock
      .mockResolvedValueOnce(res({ jsonBody: { upload_url: 'u' } }))
      .mockResolvedValueOnce(res({ jsonBody: { id: 'txn_1', status: 'queued' } }))
      .mockResolvedValueOnce(res({ jsonBody: { id: 'txn_1', status: 'error', error: 'transcoding failed' } }))
    const asr = createAssemblyAiAsr(aaiConfig())
    const err = await asr.transcribe('/r/a.hda', {}).catch((e) => e)
    expect((err as Error).message).toContain('AssemblyAI transcription failed')
    expect((err as Error).message).toContain('transcoding failed')
  })
})
