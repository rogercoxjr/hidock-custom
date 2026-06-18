import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Settings } from '../Settings'

// --- Store mocks (mirror Settings.test.tsx pattern) ---

const mockLoadConfig = vi.fn()
const mockUpdateConfig = vi.fn()
const mockSyncCalendar = vi.fn()

vi.mock('@/store/useAppStore', () => ({
  useAppStore: vi.fn((selector) => {
    const state = { syncCalendar: mockSyncCalendar, calendarSyncing: false }
    if (typeof selector === 'function') return selector(state)
    return state
  }),
  useCalendarSyncing: vi.fn(() => false),
}))

// Stable config reference — prevents the [config] useEffect from re-firing on every re-render
// (mirrors the pattern in Settings.test.tsx)
const mockConfig = {
  calendar: {
    icsUrl: '',
    syncEnabled: true,
    syncIntervalMinutes: 15,
    lastSyncAt: null,
  },
  transcription: {
    provider: 'assemblyai' as const,
    geminiApiKey: '',
    geminiModel: 'gemini-3-pro-preview',
    openaiApiKey: '',
    whisperModel: 'whisper-1',
    assemblyaiApiKey: '',
    assemblyaiModels: ['universal-3-pro', 'universal-2'],
    autoTranscribe: true,
    language: 'en',
  },
  chat: { provider: 'gemini' as const, maxContextChunks: 10, geminiModel: 'gemini-3-pro-preview', ollamaModel: 'llama3.2' },
  embeddings: { provider: 'ollama' as const, ollamaBaseUrl: 'http://localhost:11434', ollamaModel: 'nomic-embed-text', chunkSize: 512, chunkOverlap: 50 },
  summarization: { provider: 'gemini' as const, ollamaCloudApiKey: '', ollamaCloudModel: '' },
}

vi.mock('@/store/domain/useConfigStore', () => ({
  useConfigStore: vi.fn((selector?: any) => {
    const state = {
      config: mockConfig,
      loadConfig: mockLoadConfig,
      updateConfig: mockUpdateConfig,
      configLoading: false,
    }
    if (typeof selector === 'function') return selector(state)
    return state
  }),
}))

vi.mock('@/components/HealthCheck', () => ({
  HealthCheck: () => <div data-testid="health-check">Health Check</div>,
}))

// Electron API surface — mirror Settings.test.tsx
global.window.electronAPI = {
  config: {
    get: vi.fn().mockResolvedValue({ success: true, data: mockConfig }),
    updateSection: vi.fn().mockResolvedValue({ success: true }),
  },
  summarization: {
    listModels: vi.fn().mockResolvedValue({ success: true, models: [] }),
    testConnection: vi.fn().mockResolvedValue({ success: true }),
  },
  storage: {
    getInfo: vi.fn().mockResolvedValue({
      success: true,
      data: {
        dataPath: '/data',
        recordingsPath: '/recordings',
        transcriptsPath: '/transcripts',
        cachePath: '/cache',
        databasePath: '/db',
        totalSizeBytes: 0,
        recordingsCount: 0,
      },
    }),
    openFolder: vi.fn(),
  },
} as any

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Settings — AssemblyAI privacy disclosure (AC10)', () => {
  it('renders the cloud/global-routing disclosure when AssemblyAI is the selected provider', () => {
    render(<Settings />)
    expect(
      screen.getByText(
        /Speaker detection uses AssemblyAI \(cloud, global routing\); recordings are uploaded for processing\./i
      )
    ).toBeInTheDocument()
  })

  it('does not render the disclosure when Gemini is the selected provider', () => {
    render(<Settings />)
    // Click the Gemini ASR provider button to switch away from AssemblyAI
    fireEvent.click(screen.getByRole('button', { name: /use gemini asr provider/i }))
    expect(
      screen.queryByText(/Speaker detection uses AssemblyAI \(cloud, global routing\)/i)
    ).not.toBeInTheDocument()
  })
})
