import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getChatProvider, type ChatProvider } from '../chat/chat-provider'
import type { OllamaChatMessage } from '../ollama'

// chat-provider.ts imports config.ts, which touches Electron's app.getPath at load time
vi.mock('../config', () => ({
  getConfig: vi.fn(() => ({
    version: '1.0.0',
    storage: { dataPath: '/tmp', maxRecordingsGB: 50 },
    calendar: { icsUrl: '', syncEnabled: false, syncIntervalMinutes: 15, lastSyncAt: null },
    transcription: { provider: 'assemblyai', geminiApiKey: 'AIza-test-key', geminiModel: 'gemini-2.0-flash', openaiApiKey: '', whisperModel: 'whisper-1', assemblyaiApiKey: '', assemblyaiModels: [], autoTranscribe: false, language: 'en', diarization: { speakerOptionsEnabled: true, minSpeakers: 2, maxSpeakers: 8, minDurationMsForHint: 120000, policyVersion: 1 } },
    embeddings: { provider: 'openai', ollamaBaseUrl: '', ollamaModel: '', openaiModel: 'text-embedding-3-small', chunkSize: 500, chunkOverlap: 50 },
    chat: { provider: 'gemini', geminiModel: 'gemini-2.0-flash', ollamaModel: 'llama3.2', maxContextChunks: 10 },
    summarization: { provider: 'ollama-cloud', ollamaCloudApiKey: 'oc-test-key', ollamaCloudModel: 'gpt-oss:120b' },
    device: { autoConnect: false, autoDownload: false },
    ui: { theme: 'system', defaultView: 'week', startOfWeek: 1, calendarView: 'week', hideEmptyMeetings: true, showListView: false },
    privacy: { enableVoiceprintCapture: false, excludeVoiceprintsFromBackup: true },
    voiceMatching: { matchSuggest: 0.42, matchAuto: 0.55, matchMargin: 0.06, mergeThreshold: 0.62, mixedDispersion: 0.35, centroidOutlier: 0.25, bankConsistency: 0.35, maxMergeSuggestions: 5, calibrated: false, modelId: '3dspeaker_eres2net_en_voxceleb' }
  })),
  initializeConfig: vi.fn(),
  saveConfig: vi.fn(),
  getConfigPath: vi.fn(),
  getDataPath: vi.fn(),
  encryptSensitive: vi.fn((v: string) => v),
  decryptSensitive: vi.fn((v: string) => v)
}))

const baseConfig = {
  version: '1.0.0',
  storage: { dataPath: '/tmp', maxRecordingsGB: 50 },
  calendar: { icsUrl: '', syncEnabled: false, syncIntervalMinutes: 15, lastSyncAt: null },
  transcription: {
    provider: 'assemblyai' as const,
    geminiApiKey: 'AIza-test-key',
    geminiModel: 'gemini-2.0-flash',
    openaiApiKey: '',
    whisperModel: 'whisper-1',
    assemblyaiApiKey: '',
    assemblyaiModels: [],
    autoTranscribe: false,
    language: 'en',
    diarization: { speakerOptionsEnabled: true, minSpeakers: 2, maxSpeakers: 8, minDurationMsForHint: 120000, policyVersion: 1 }
  },
  embeddings: {
    provider: 'openai' as const,
    ollamaBaseUrl: '',
    ollamaModel: '',
    openaiModel: 'text-embedding-3-small',
    chunkSize: 500,
    chunkOverlap: 50
  },
  chat: {
    provider: 'gemini' as const,
    geminiModel: 'gemini-2.0-flash',
    ollamaModel: 'llama3.2',
    maxContextChunks: 10
  },
  summarization: {
    provider: 'ollama-cloud' as const,
    ollamaCloudApiKey: 'oc-test-key',
    ollamaCloudModel: 'gpt-oss:120b'
  },
  device: { autoConnect: false, autoDownload: false },
  ui: {
    theme: 'system' as const,
    defaultView: 'week' as const,
    startOfWeek: 1,
    calendarView: 'week' as const,
    hideEmptyMeetings: true,
    showListView: false
  },
  privacy: { enableVoiceprintCapture: false, excludeVoiceprintsFromBackup: true },
  voiceMatching: {
    matchSuggest: 0.42,
    matchAuto: 0.55,
    matchMargin: 0.06,
    mergeThreshold: 0.62,
    mixedDispersion: 0.35,
    centroidOutlier: 0.25,
    bankConsistency: 0.35,
    maxMergeSuggestions: 5,
    calibrated: false,
    modelId: '3dspeaker_eres2net_en_voxceleb'
  }
}

const mockOllamaService = {
  isAvailable: vi.fn().mockResolvedValue(true),
  ensureModels: vi.fn().mockResolvedValue({ embedding: true, chat: true }),
  chat: vi.fn().mockResolvedValue('local ollama response'),
  generate: vi.fn().mockResolvedValue('local ollama generation')
}

vi.mock('../ollama', () => ({
  getOllamaService: vi.fn(() => mockOllamaService)
}))

describe('getChatProvider', () => {
  it('routes to the local Ollama provider', async () => {
    const provider = getChatProvider({
      ...baseConfig,
      chat: { ...baseConfig.chat, provider: 'ollama' }
    })

    const messages: OllamaChatMessage[] = [{ role: 'user', content: 'hi' }]
    const answer = await provider.chat(messages, { systemPrompt: 'sys', temperature: 0.5, maxTokens: 128 })

    expect(answer).toBe('local ollama response')
    expect(mockOllamaService.chat).toHaveBeenCalledWith(messages, {
      systemPrompt: 'sys',
      temperature: 0.5,
      maxTokens: 128,
      signal: undefined
    })
  })

  it('routes to the local Ollama provider for generate()', async () => {
    const provider = getChatProvider({
      ...baseConfig,
      chat: { ...baseConfig.chat, provider: 'ollama' }
    })

    const answer = await provider.generate('prompt', { systemPrompt: 'sys' })

    expect(answer).toBe('local ollama generation')
    expect(mockOllamaService.generate).toHaveBeenCalledWith('prompt', 'sys')
  })

  it('throws when Gemini is selected but no API key is present', () => {
    expect(() =>
      getChatProvider({
        ...baseConfig,
        transcription: { ...baseConfig.transcription, geminiApiKey: '' }
      })
    ).toThrow('Gemini API key not configured')
  })
})

describe('Ollama Cloud chat provider', () => {
  let fetchSpy: ReturnType<typeof vi.fn>
  let provider: ChatProvider

  beforeEach(() => {
    fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    provider = getChatProvider({
      ...baseConfig,
      chat: { ...baseConfig.chat, provider: 'ollama-cloud' }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends a single user message for generate()', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ message: { content: 'cloud generate response' } })
    })

    const answer = await provider.generate('summarize this', { systemPrompt: 'sys', temperature: 0.5, maxTokens: 256 })

    expect(answer).toBe('cloud generate response')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://ollama.com/api/chat')
    const body = JSON.parse(init.body)
    expect(body.model).toBe('gpt-oss:120b')
    expect(body.stream).toBe(false)
    expect(body.messages).toEqual([{ role: 'user', content: 'summarize this' }])
    expect(body.options).toEqual({ temperature: 0.5, num_predict: 256 })
    expect(init.headers).toMatchObject({ Authorization: 'Bearer oc-test-key' })
  })

  it('sends the full message list for chat()', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ message: { content: 'cloud chat response' } })
    })

    const messages: OllamaChatMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' }
    ]
    const answer = await provider.chat(messages)

    expect(answer).toBe('cloud chat response')
    const [, init] = fetchSpy.mock.calls[0]
    const body = JSON.parse(init.body)
    expect(body.messages).toEqual(messages)
  })

  it('throws ProviderAuthError on HTTP 401', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 401, text: async () => 'unauthorized' })

    await expect(provider.generate('prompt')).rejects.toThrow('Ollama Cloud API key was rejected')
  })

  it('respects abort signals', async () => {
    fetchSpy.mockImplementation((_url, init: RequestInit) => new Promise((_, reject) => {
      const signal = init.signal
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))

    const controller = new AbortController()
    const promise = provider.chat([{ role: 'user', content: 'hi' }], { signal: controller.signal })
    controller.abort()

    await expect(promise).rejects.toThrow()
  })
})
