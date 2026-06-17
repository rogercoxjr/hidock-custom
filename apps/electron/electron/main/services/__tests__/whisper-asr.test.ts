/**
 * whisper-asr tests — auto-pipeline P2, Task 3.
 *
 * Verifies the OpenAI Whisper ASR provider: key-missing guard (spec §7.1
 * verbatim), single- and multi-chunk happy paths (multipart verbose_json,
 * Bearer auth, language from first chunk), typed 429/401 errors, the
 * insufficient_quota distinction inside the 429 branch (spec §7.1), the 10-min
 * AbortController timeout (spec §7.4), and that opts.meetingContext is ignored.
 *
 * normalizeForWhisper / cleanAsrTempDir are mocked — no real ffmpeg/disk. global
 * fetch is stubbed via vi.stubGlobal. readFileSync is mocked so the chunk loop
 * does not need real files.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted controllable state — must exist before vi.mock factories.
// ---------------------------------------------------------------------------
const { shared } = vi.hoisted(() => ({
  shared: {
    normalizeFiles: ['/t/a.norm.mp3'] as string[]
  }
}))

// ---------------------------------------------------------------------------
// Mock: ./audio-normalize — normalizeForWhisper returns controllable files;
// cleanAsrTempDir is a spy so the finally-block call is observable.
// ---------------------------------------------------------------------------
const mockNormalize = vi.fn(async (_inputPath: string) => ({ files: shared.normalizeFiles }))
const mockClean = vi.fn(() => {})
vi.mock('../asr/audio-normalize', () => ({
  normalizeForWhisper: (inputPath: string) => mockNormalize(inputPath),
  cleanAsrTempDir: () => mockClean()
}))

// ---------------------------------------------------------------------------
// Mock: fs.readFileSync — chunk loop reads each file; return deterministic bytes.
// ---------------------------------------------------------------------------
vi.mock('fs', () => ({
  readFileSync: vi.fn(() => Buffer.from('AUDIO'))
}))

import { createWhisperAsr } from '../asr/whisper-asr'
import { ProviderRateLimitError, ProviderAuthError } from '../provider-errors'

// Narrow test double of AppConfig — only the fields createWhisperAsr reads.
function whisperConfig(openaiApiKey = 'sk-x', whisperModel = 'whisper-1', language?: string) {
  return {
    transcription: { provider: 'openai-whisper', openaiApiKey, whisperModel, language }
  } as never
}

// Build a Response-like stub. `body` is the text() payload (for the 429 path).
function fetchResponse(opts: {
  status?: number
  ok?: boolean
  jsonBody?: unknown
  textBody?: string
  retryAfter?: string
}) {
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
  shared.normalizeFiles = ['/t/a.norm.mp3']
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('createWhisperAsr — construction', () => {
  it('throws the spec §7.1 verbatim message when the key is missing', () => {
    expect(() => createWhisperAsr(whisperConfig(''))).toThrow(
      'OpenAI API key not configured — add it in Settings → Transcription'
    )
  })
})

describe('createWhisperAsr — single-chunk happy path', () => {
  it('POSTs verbose_json multipart with Bearer auth and returns text + language', async () => {
    fetchMock.mockResolvedValueOnce(fetchResponse({ jsonBody: { text: 'HELLO', language: 'english' } }))
    const asr = createWhisperAsr(whisperConfig('sk-x'))
    const result = await asr.transcribe('/recordings/a.hda', {})

    expect(result).toEqual({ text: 'HELLO', language: 'english' })
    // always-transcode: normalizeForWhisper invoked exactly once with the input
    expect(mockNormalize).toHaveBeenCalledTimes(1)
    expect(mockNormalize).toHaveBeenCalledWith('/recordings/a.hda')
    // cleanup ran (finally block)
    expect(mockClean).toHaveBeenCalledTimes(1)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-x')

    const form = init.body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect(form.get('model')).toBe('whisper-1')
    expect(form.get('response_format')).toBe('verbose_json')
    expect(form.get('file')).toBeInstanceOf(Blob)
  })
})

describe('createWhisperAsr — multi-chunk', () => {
  it('joins chunk texts with newline; language from the FIRST chunk', async () => {
    shared.normalizeFiles = ['/t/p0.mp3', '/t/p1.mp3', '/t/p2.mp3']
    fetchMock
      .mockResolvedValueOnce(fetchResponse({ jsonBody: { text: 'one', language: 'english' } }))
      .mockResolvedValueOnce(fetchResponse({ jsonBody: { text: 'two', language: 'spanish' } }))
      .mockResolvedValueOnce(fetchResponse({ jsonBody: { text: 'three' } }))

    const asr = createWhisperAsr(whisperConfig('sk-x'))
    const result = await asr.transcribe('/recordings/long.hda', {})

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(result.text).toBe('one\ntwo\nthree')
    expect(result.language).toBe('english') // first chunk
    expect(mockClean).toHaveBeenCalledTimes(1)
  })
})

describe('createWhisperAsr — error classification', () => {
  it('429 without insufficient_quota → ProviderRateLimitError with retryAfterMs', async () => {
    fetchMock.mockResolvedValue(
      fetchResponse({ status: 429, textBody: '{"error":{"message":"rate limited"}}', retryAfter: '120' })
    )
    const asr = createWhisperAsr(whisperConfig('sk-x'))
    const err = await asr.transcribe('/r/a.hda', {}).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderRateLimitError)
    expect((err as ProviderRateLimitError).provider).toBe('OpenAI')
    expect((err as ProviderRateLimitError).retryAfterMs).toBe(120000)
    expect(mockClean).toHaveBeenCalled() // cleanup ran on failure path
  })

  it('429 with insufficient_quota → plain Error with the spec §7.1 verbatim message', async () => {
    fetchMock.mockResolvedValue(
      fetchResponse({ status: 429, textBody: '{"error":{"code":"insufficient_quota"}}' })
    )
    const asr = createWhisperAsr(whisperConfig('sk-x'))
    const err = await asr.transcribe('/r/a.hda', {}).catch((e) => e)
    expect((err as Error).message).toBe('OpenAI quota exhausted — check billing, then Retry all')
    // must NOT be a ProviderRateLimitError — quota is terminal, not parkable
    expect(err).not.toBeInstanceOf(ProviderRateLimitError)
  })

  it('401 → ProviderAuthError(OpenAI)', async () => {
    fetchMock.mockResolvedValue(fetchResponse({ status: 401, textBody: 'unauthorized' }))
    const asr = createWhisperAsr(whisperConfig('sk-x'))
    const err = await asr.transcribe('/r/a.hda', {}).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderAuthError)
    expect((err as Error).message).toContain('OpenAI API key was rejected')
  })
})

describe('createWhisperAsr — timeout', () => {
  it('aborts after the 10-min timeout when fetch never resolves', async () => {
    vi.useFakeTimers()
    // fetch that rejects when its AbortSignal fires (mirrors real fetch abort).
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init.signal as AbortSignal
        signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted (timeout)')
          err.name = 'AbortError'
          reject(err)
        })
      })
    })
    const asr = createWhisperAsr(whisperConfig('sk-x'))
    const promise = asr.transcribe('/r/a.hda', {})
    const assertion = expect(promise).rejects.toThrow(/abort/i)
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1)
    await assertion
  })
})

describe('createWhisperAsr — language', () => {
  it('appends the configured language to the multipart form when set', async () => {
    fetchMock.mockResolvedValueOnce(fetchResponse({ jsonBody: { text: 'HELLO' } }))
    const asr = createWhisperAsr(whisperConfig('sk-x', 'whisper-1', 'en'))
    await asr.transcribe('/r/a.hda', {})
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const form = init.body as FormData
    expect(form.get('language')).toBe('en')
  })

  it('omits the language field when language is "auto"', async () => {
    fetchMock.mockResolvedValueOnce(fetchResponse({ jsonBody: { text: 'HELLO' } }))
    const asr = createWhisperAsr(whisperConfig('sk-x', 'whisper-1', 'auto'))
    await asr.transcribe('/r/a.hda', {})
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const form = init.body as FormData
    expect(form.get('language')).toBeNull()
  })

  it('omits the language field when language is undefined', async () => {
    fetchMock.mockResolvedValueOnce(fetchResponse({ jsonBody: { text: 'HELLO' } }))
    const asr = createWhisperAsr(whisperConfig('sk-x', 'whisper-1', undefined))
    await asr.transcribe('/r/a.hda', {})
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const form = init.body as FormData
    expect(form.get('language')).toBeNull()
  })
})

describe('createWhisperAsr — meetingContext is ignored', () => {
  it('does not add a prompt field to the FormData (spec §5.1)', async () => {
    fetchMock.mockResolvedValueOnce(fetchResponse({ jsonBody: { text: 'X' } }))
    const asr = createWhisperAsr(whisperConfig('sk-x'))
    await asr.transcribe('/r/a.hda', { meetingContext: 'IMPORTANT VOCAB' })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const form = init.body as FormData
    expect(form.get('prompt')).toBeNull()
    expect(JSON.stringify([...(form as unknown as Iterable<[string, unknown]>)])).not.toContain('IMPORTANT VOCAB')
  })
})
