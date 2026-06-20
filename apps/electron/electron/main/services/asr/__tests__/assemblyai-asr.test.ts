/**
 * assemblyai-asr tests — speaker-diarization D1, Task 3.
 *
 * Verifies the AssemblyAI provider: loud key-missing guard (§8/AC9), the
 * upload→submit→poll flow, the submit body (speech_models ARRAY incl.
 * universal-3-pro, speaker_labels, sentiment_analysis, keyterms_prompt,
 * language_code 'en' — and NEVER singular speech_model, NEVER word_boost,
 * NEVER model_region (the live API rejects it with 400 — AC8),
 * utterances→Turn[] with start/end passed through as MILLISECONDS (AssemblyAI
 * already returns ms — AC1), and 401/429/error/poll-timeout classification (§8/AC7).
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
  vi.useFakeTimers() // poll waits run on fake timers — no real sleeps (suite stays fast)
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** Drive a transcribe() that submits with status 'queued' then resolves on the
 *  first GET poll. The poll loop awaits setTimeout(POLL_INTERVAL_MS); advance fake
 *  timers past one interval so the loop proceeds, then await the settled result. */
const POLL_INTERVAL_MS = 3000
const POLL_WALL_CLOCK_MS = 30 * 60 * 1000
async function runWithPoll<T>(p: Promise<T>): Promise<T> {
  // Flush the upload+submit microtasks, then release the single poll wait.
  await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
  return p
}

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
            // AssemblyAI returns start/end in MILLISECONDS (confirmed against the live API:
            // a ~5s clip's only utterance ended at 1486). The provider must pass these
            // through unchanged — NOT multiply by 1000.
            utterances: [
              { speaker: 'A', start: 0, end: 1500, text: 'Hello there.', sentiment: 'POSITIVE',
                words: [{ text: 'Hello', start: 0, end: 500 }, { text: 'there.', start: 500, end: 1500 }] },
              { speaker: 'B', start: 2000, end: 3250, text: 'General Kenobi.', sentiment: 'NEUTRAL',
                words: [{ text: 'General', start: 2000, end: 2600 }, { text: 'Kenobi.', start: 2600, end: 3250 }] }
            ]
          }
        })
      )
  })

  it('returns text + language + structured turns with start/end passed through as ms (AC1)', async () => {
    const asr = createAssemblyAiAsr(aaiConfig())
    const result = await runWithPoll(asr.transcribe('/recordings/a.hda', {}))
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

  it('submit body uses speech_models ARRAY incl. universal-3-pro, speaker_labels, language_code; NEVER singular speech_model, word_boost, model_region, or sentiment_analysis (AC8)', async () => {
    const asr = createAssemblyAiAsr(aaiConfig())
    await runWithPoll(asr.transcribe('/recordings/a.hda', { meetingContext: 'Acme Corp; Project Phoenix' }))

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
    expect(body.speaker_labels).toBe(true)
    expect(body.language_code).toBe('en')
    // forbidden keys — singular speech_model (deprecated), word_boost (silent downgrade),
    // model_region (live API rejects it: 400 "Invalid endpoint schema"), and
    // sentiment_analysis (billed +$0.02/hr but the result lives in a separate
    // sentiment_analysis_results array we never read — dropped per 2026-06-18 decision).
    expect(body).not.toHaveProperty('speech_model')
    expect(body).not.toHaveProperty('word_boost')
    expect(body).not.toHaveProperty('model_region')
    expect(body).not.toHaveProperty('sentiment_analysis')
    // Phase 5: never send the singular `speakers_expected` (mutually exclusive
    // with `speaker_options`).
    expect(body).not.toHaveProperty('speakers_expected')
  })

  it('sends speaker_options when opts.speakerOptions is provided', async () => {
    const asr = createAssemblyAiAsr(aaiConfig())
    await runWithPoll(
      asr.transcribe('/recordings/a.hda', { speakerOptions: { min_speakers_expected: 1, max_speakers_expected: 8 } })
    )
    const body = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string)
    expect(body.speaker_options).toEqual({ min_speakers_expected: 1, max_speakers_expected: 8 })
    expect(body).not.toHaveProperty('speakers_expected')
  })

  it('omits speaker_options when opts.speakerOptions is absent', async () => {
    const asr = createAssemblyAiAsr(aaiConfig())
    await runWithPoll(asr.transcribe('/recordings/a.hda', {}))
    const body = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string)
    expect(body).not.toHaveProperty('speaker_options')
    expect(body).not.toHaveProperty('speakers_expected')
  })

  it('builds keyterms_prompt from meetingContext (NOT word_boost)', async () => {
    const asr = createAssemblyAiAsr(aaiConfig())
    await runWithPoll(asr.transcribe('/recordings/a.hda', { meetingContext: 'Acme Corp; Project Phoenix' }))
    const body = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string)
    expect(Array.isArray(body.keyterms_prompt)).toBe(true)
    expect(body.keyterms_prompt).toContain('Acme Corp')
    expect(body.keyterms_prompt).toContain('Project Phoenix')
  })

  it('drops keyterms_prompt phrases longer than 6 words (plan line ~70)', async () => {
    const asr = createAssemblyAiAsr(aaiConfig())
    // 7-word phrase exceeds the ≤6-words rule → must NOT appear; 6-word phrase kept.
    const tooLong = 'one two three four five six seven'
    const sixWords = 'alpha beta gamma delta epsilon zeta'
    await runWithPoll(asr.transcribe('/recordings/a.hda', { meetingContext: `${tooLong}; ${sixWords}; Acme Corp` }))
    const body = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string)
    expect(body.keyterms_prompt).not.toContain(tooLong)
    expect(body.keyterms_prompt).toContain(sixWords)
    expect(body.keyterms_prompt).toContain('Acme Corp')
    // every retained phrase has ≤6 words
    for (const phrase of body.keyterms_prompt as string[]) {
      expect(phrase.split(/\s+/).length).toBeLessThanOrEqual(6)
    }
  })

  it('sends keyterms_prompt and NEVER a sibling `prompt` field (mutually exclusive — plan line ~70)', async () => {
    const asr = createAssemblyAiAsr(aaiConfig())
    await runWithPoll(asr.transcribe('/recordings/a.hda', { meetingContext: 'Acme Corp; Project Phoenix' }))
    const body = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string)
    expect(body).toHaveProperty('keyterms_prompt')
    expect(body).not.toHaveProperty('prompt')
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
    const err = await runWithPoll(asr.transcribe('/r/a.hda', {}).catch((e) => e))
    expect((err as Error).message).toContain('AssemblyAI transcription failed')
    expect((err as Error).message).toContain('transcoding failed')
  })

  it('poll exceeding the wall-clock cap → "AssemblyAI poll timed out" Error (§8)', async () => {
    // submit returns 'queued'; every GET poll stays 'processing' so the loop never
    // completes — advancing past POLL_WALL_CLOCK_MS must trip the hard deadline.
    fetchMock
      .mockResolvedValueOnce(res({ jsonBody: { upload_url: 'u' } }))
      .mockResolvedValueOnce(res({ jsonBody: { id: 'txn_1', status: 'queued' } }))
      .mockResolvedValue(res({ jsonBody: { id: 'txn_1', status: 'processing' } }))
    const asr = createAssemblyAiAsr(aaiConfig())
    const promise = asr.transcribe('/r/a.hda', {}).catch((e) => e)
    // Walk the clock past the wall-clock cap in interval-sized steps so each
    // poll wait resolves and the next loop iteration re-checks the deadline.
    await vi.advanceTimersByTimeAsync(POLL_WALL_CLOCK_MS + POLL_INTERVAL_MS)
    const err = await promise
    expect((err as Error).message).toContain('AssemblyAI poll timed out')
  })
})
