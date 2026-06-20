
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getOutputGeneratorService } from '../output-generator'
import * as db from '../database'

// Mock dependencies
vi.mock('../database', () => ({
  getMeetingById: vi.fn(),
  getRecordingsForMeeting: vi.fn(),
  getTranscriptByRecordingId: vi.fn(),
  getMeetingsForProject: vi.fn(),
  getMeetingsForContact: vi.fn(),
  getProjectById: vi.fn(),
  getContactById: vi.fn(),
  queryOne: vi.fn()
}))

vi.mock('../ollama', () => ({
  getOllamaService: vi.fn(() => ({
    isAvailable: vi.fn().mockResolvedValue(true),
    generate: vi.fn().mockResolvedValue('Generated Content')
  }))
}))

// chat-provider resolves config at module load; keep the test on the local Ollama path
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

describe('OutputGeneratorService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should generate output for a knowledge capture', async () => {
    const generator = getOutputGeneratorService()
    
    vi.mocked(db.queryOne).mockReturnValue({
      id: 'kc-1',
      title: 'Knowledge Capture 1',
      source_recording_id: 'rec-1',
      captured_at: new Date().toISOString()
    })
    
    vi.mocked(db.getTranscriptByRecordingId).mockReturnValue({
      id: 'trans-1',
      recording_id: 'rec-1',
      full_text: 'Full transcript text',
      language: 'en',
      created_at: new Date().toISOString()
    } as any)

    const result = await generator.generate({
      templateId: 'meeting_minutes',
      knowledgeCaptureId: 'kc-1'
    })

    expect(result.content).toBe('Generated Content')
    expect(db.queryOne).toHaveBeenCalledWith(expect.stringContaining('knowledge_captures'), ['kc-1'])
  })
})
