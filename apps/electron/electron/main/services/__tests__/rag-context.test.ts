
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getRAGService, resetRAGService } from '../rag'
import BetterSqlite3 from 'better-sqlite3'

// Stable mock object
const mockOllamaService = {
  isAvailable: vi.fn().mockResolvedValue(true),
  ensureModels: vi.fn().mockResolvedValue({ embedding: true, chat: true }),
  chat: vi.fn().mockResolvedValue('AI Response'),
  generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2])
}

// Mock dependencies (except database)
vi.mock('../ollama', () => ({
  getOllamaService: vi.fn(() => mockOllamaService)
}))

// chat-provider reads config at resolution time, so give it an ollama-backed config
vi.mock('../config', () => ({
  getConfig: vi.fn(() => ({
    version: '1.0.0',
    storage: { dataPath: '/tmp', maxRecordingsGB: 50 },
    calendar: { icsUrl: '', syncEnabled: false, syncIntervalMinutes: 15, lastSyncAt: null },
    transcription: { provider: 'assemblyai', geminiApiKey: '', geminiModel: '', openaiApiKey: '', whisperModel: 'whisper-1', assemblyaiApiKey: '', assemblyaiModels: [], autoTranscribe: false, language: 'en' },
    embeddings: { provider: 'openai', ollamaBaseUrl: '', ollamaModel: '', openaiModel: 'text-embedding-3-small', chunkSize: 500, chunkOverlap: 50 },
    chat: { provider: 'ollama', geminiModel: '', ollamaModel: 'llama3.2', maxContextChunks: 10 },
    summarization: { provider: 'gemini', ollamaCloudApiKey: '', ollamaCloudModel: '' },
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

// rag.ts now resolves the query embedding through the embedding provider.
vi.mock('../embeddings/embedding-provider', () => ({
  getEmbeddingService: vi.fn(() => ({
    generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2])
  }))
}))

vi.mock('../vector-store', () => ({
  getVectorStore: vi.fn(() => ({
    initialize: vi.fn().mockResolvedValue(true),
    getDocumentCount: vi.fn().mockReturnValue(10),
    getMeetingCount: vi.fn().mockReturnValue(5),
    search: vi.fn().mockResolvedValue([])
  }))
}))

let dbInstance: any = null
vi.mock('../database', () => ({
  getDatabase: () => dbInstance,
  queryOne: vi.fn((sql: string, params: any[]) => {
    if (!dbInstance) return undefined
    return dbInstance.prepare(sql).get(...(params ?? [])) ?? undefined
  }),
  escapeLikePattern: vi.fn((pattern: string) => pattern.replace(/[%_\\]/g, '\\$&'))
}))

describe('RAGService Context Injection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRAGService()
    dbInstance = new BetterSqlite3(':memory:')

    // Setup tables
    dbInstance.exec(`
      CREATE TABLE conversations (id TEXT PRIMARY KEY);
      CREATE TABLE conversation_context (id TEXT, conversation_id TEXT, knowledge_capture_id TEXT);
      CREATE TABLE knowledge_captures (id TEXT, title TEXT, source_recording_id TEXT);
      CREATE TABLE transcripts (recording_id TEXT, full_text TEXT);

      INSERT INTO conversations (id) VALUES ('session-1');
      INSERT INTO knowledge_captures (id, title, source_recording_id) VALUES ('kc-1', 'Test Title', 'rec-1');
      INSERT INTO transcripts (recording_id, full_text) VALUES ('rec-1', 'Full transcript text from knowledge capture');
      INSERT INTO conversation_context (id, conversation_id, knowledge_capture_id) VALUES ('ctx-1', 'session-1', 'kc-1');
    `)
  })

  afterEach(() => {
    if (dbInstance) dbInstance.close()
  })

  it('should include conversation context in the prompt', async () => {
    const rag = getRAGService()
    
    await rag.chat('session-1', 'What is in the context?')

    expect(mockOllamaService.chat).toHaveBeenCalled()
    
    const lastCall = vi.mocked(mockOllamaService.chat).mock.calls[0]
    const messages = lastCall[0]
    const userMessage = messages[messages.length - 1].content
    expect(userMessage).toContain('Full transcript text from knowledge capture')
    expect(userMessage).toContain('PINNED CONTEXT: Test Title')
  })
})
