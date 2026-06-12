
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { Settings } from '../Settings'

const mockLoadConfig = vi.fn()
const mockUpdateConfig = vi.fn()
const mockSyncCalendar = vi.fn()

// Mock the stores
vi.mock('@/store/useAppStore', () => ({
  useAppStore: vi.fn((selector) => {
    const state = {
      syncCalendar: mockSyncCalendar,
      calendarSyncing: false
    }
    if (typeof selector === 'function') return selector(state)
    return state
  }),
  useCalendarSyncing: vi.fn(() => false)
}))

// Stable config reference — prevents the [config] useEffect from re-firing on every re-render
const mockConfig = {
  calendar: {
    icsUrl: 'https://example.com/cal.ics',
    syncEnabled: true,
    syncIntervalMinutes: 15,
    lastSyncAt: '2026-03-01T10:00:00Z'
  },
  transcription: {
    provider: 'gemini' as const,
    geminiApiKey: 'AIzaTestKey12345',
    geminiModel: 'gemini-3-pro-preview',
    openaiApiKey: '',
    whisperModel: 'whisper-1'
  },
  summarization: {
    provider: 'gemini' as const,
    ollamaCloudApiKey: '',
    ollamaCloudModel: ''
  },
  chat: { provider: 'gemini' as const, maxContextChunks: 10, geminiModel: 'gemini-3-pro-preview', ollamaModel: 'llama3.2' },
  embeddings: { ollamaBaseUrl: 'http://localhost:11434' }
}

vi.mock('@/store/domain/useConfigStore', () => ({
  useConfigStore: vi.fn((selector?: any) => {
    const state = {
      config: mockConfig,
      loadConfig: mockLoadConfig,
      updateConfig: mockUpdateConfig,
      configLoading: false
    }
    if (typeof selector === 'function') return selector(state)
    return state
  })
}))

// Mock HealthCheck component
vi.mock('@/components/HealthCheck', () => ({
  HealthCheck: () => <div data-testid="health-check">Health Check</div>
}))

const mockListModels = vi.fn().mockResolvedValue({ success: true, models: ['gpt-oss:120b', 'deepseek-v3.1:671b'] })
const mockTestConnection = vi.fn().mockResolvedValue({ success: true })

// Mock Electron API
global.window.electronAPI = {
  config: {
    get: vi.fn().mockResolvedValue({
      success: true,
      data: {
        calendar: { icsUrl: '', syncEnabled: true, syncIntervalMinutes: 15 },
        transcription: { geminiApiKey: '', geminiModel: 'gemini-3-pro-preview' },
        chat: { provider: 'gemini' },
        embeddings: { ollamaBaseUrl: 'http://localhost:11434' }
      }
    }),
    updateSection: vi.fn().mockResolvedValue({ success: true })
  },
  summarization: {
    listModels: mockListModels,
    testConnection: mockTestConnection
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
        totalSizeBytes: 1024000,
        recordingsCount: 5
      }
    }),
    openFolder: vi.fn()
  }
} as any

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Settings Page', () => {
  it('should render settings sections', async () => {
    render(<Settings />)

    expect(screen.getByText('Calendar')).toBeInTheDocument()
    expect(screen.getByText('Transcription')).toBeInTheDocument()
    expect(screen.getByText('Chat / RAG')).toBeInTheDocument()
    expect(screen.getByText('Storage')).toBeInTheDocument()
  })

  it('should render calendar settings form', async () => {
    render(<Settings />)

    expect(screen.getByLabelText('ICS Calendar URL')).toBeInTheDocument()
    expect(screen.getByLabelText('Enable auto-sync')).toBeInTheDocument()
    expect(screen.getByLabelText('Sync interval in minutes')).toBeInTheDocument()
  })

  it('should render transcription settings form', async () => {
    render(<Settings />)

    expect(screen.getByLabelText('Gemini API Key')).toBeInTheDocument()
    expect(screen.getByLabelText('Transcription Model')).toBeInTheDocument()
  })

  it('should render chat provider toggle buttons', async () => {
    render(<Settings />)

    expect(screen.getByLabelText('Use Gemini chat provider')).toBeInTheDocument()
    expect(screen.getByLabelText('Use Ollama local chat provider')).toBeInTheDocument()
  })

  it('should render save buttons for each section', async () => {
    render(<Settings />)

    const saveButtons = screen.getAllByLabelText(/Save.*settings/)
    expect(saveButtons.length).toBe(4) // Calendar, Transcription, Summarization, Chat
  })

  it('should render storage section', async () => {
    render(<Settings />)

    expect(screen.getByText('Storage')).toBeInTheDocument()
    expect(screen.getByText('Local data storage information')).toBeInTheDocument()
  })

  it('should render health check component', async () => {
    render(<Settings />)

    expect(screen.getByTestId('health-check')).toBeInTheDocument()
  })

  // C-006: API key visibility toggle
  it('should toggle API key visibility', async () => {
    render(<Settings />)

    const apiKeyInput = screen.getByLabelText('Gemini API Key') as HTMLInputElement

    // Default: password type
    expect(apiKeyInput.type).toBe('password')

    // Click show API key button
    const toggleButton = screen.getByLabelText('Show API key')
    fireEvent.click(toggleButton)

    // Should now be visible
    expect(apiKeyInput.type).toBe('text')

    // Click hide API key button
    const hideButton = screen.getByLabelText('Hide API key')
    fireEvent.click(hideButton)

    // Should be hidden again
    expect(apiKeyInput.type).toBe('password')
  })

  // C-006: Sync interval clamping - HTML attributes enforce valid range
  it('should render sync interval input with min/max attributes', async () => {
    render(<Settings />)

    const intervalInput = screen.getByLabelText('Sync interval in minutes') as HTMLInputElement

    // Should initialize with the config value
    expect(intervalInput.value).toBe('15')

    // Verify the input has proper min/max attributes for HTML validation
    expect(intervalInput.min).toBe('5')
    expect(intervalInput.max).toBe('120')

    // Verify input type is number
    expect(intervalInput.type).toBe('number')
  })

  // C-006: Checkbox has no redundant onKeyDown (verified by inspection; test native behavior)
  it('should render sync checkbox with onChange handler', async () => {
    render(<Settings />)

    const checkbox = screen.getByLabelText('Enable auto-sync') as HTMLInputElement

    // Default from mock config
    expect(checkbox.checked).toBe(true)

    // The checkbox should be a controlled component with only onChange,
    // not a redundant onKeyDown handler
    expect(checkbox).toBeInTheDocument()
    expect(checkbox.type).toBe('checkbox')
  })

  // C-006: Last sync time display
  it('should display last sync time when available', async () => {
    render(<Settings />)

    // The mock config has lastSyncAt set to '2026-03-01T10:00:00Z'
    expect(screen.getByText(/Last synced:/)).toBeInTheDocument()
  })

  // Task 5 — ASR provider picker
  it('should render the ASR provider toggle buttons (Gemini and OpenAI Whisper)', async () => {
    render(<Settings />)

    // Both provider buttons should be present
    expect(screen.getByLabelText('Use Gemini ASR provider')).toBeInTheDocument()
    expect(screen.getByLabelText('Use OpenAI Whisper ASR provider')).toBeInTheDocument()
  })

  it('should show Gemini fields by default and hide OpenAI Whisper fields', async () => {
    render(<Settings />)

    // Gemini key should be visible (default provider is 'gemini')
    expect(screen.getByLabelText('Gemini API Key')).toBeInTheDocument()
    // The Gemini model select should be present (by ID)
    expect(document.getElementById('geminiModel')).toBeInTheDocument()

    // OpenAI key should NOT be present yet
    expect(screen.queryByLabelText('OpenAI API Key')).not.toBeInTheDocument()
    // Whisper model select should not be present (by ID)
    expect(document.getElementById('whisperModel')).not.toBeInTheDocument()
  })

  it('should reveal OpenAI Whisper fields and hide Gemini fields when OpenAI Whisper is selected', async () => {
    render(<Settings />)

    // Click the OpenAI Whisper button — wrap in act to flush async state updates
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Use OpenAI Whisper ASR provider'))
    })

    // Gemini key and Gemini model select (by ID) should be hidden
    expect(screen.queryByLabelText('Gemini API Key')).not.toBeInTheDocument()
    expect(document.getElementById('geminiModel')).not.toBeInTheDocument()

    // OpenAI fields should now be visible
    expect(screen.getByLabelText('OpenAI API Key')).toBeInTheDocument()
    // Whisper model select rendered as disabled (by ID)
    expect(document.getElementById('whisperModel')).toBeInTheDocument()
  })

  it('should call updateConfig with openai-whisper provider and openaiApiKey when saving Whisper config', async () => {
    render(<Settings />)

    // Switch to Whisper — wrap in act to flush async state updates
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Use OpenAI Whisper ASR provider'))
    })

    // Enter an OpenAI key
    const openaiKeyInput = screen.getByLabelText('OpenAI API Key') as HTMLInputElement
    fireEvent.change(openaiKeyInput, { target: { value: 'sk-test-key-1234567890' } })

    // Click save — wrap in act to flush the async updateConfig call
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Save transcription settings'))
    })

    expect(mockUpdateConfig).toHaveBeenCalledWith(
      'transcription',
      expect.objectContaining({
        provider: 'openai-whisper',
        openaiApiKey: 'sk-test-key-1234567890',
        whisperModel: 'whisper-1'
      })
    )
  })

  // Task 6 — Summarization Settings card
  describe('Summarization card', () => {
    it('renders the Summarization card with provider toggle (Gemini | Ollama Cloud)', () => {
      render(<Settings />)
      expect(screen.getByText('Summarization')).toBeInTheDocument()
      expect(screen.getByLabelText('Use Gemini summarization provider')).toBeInTheDocument()
      expect(screen.getByLabelText('Use Ollama Cloud summarization provider')).toBeInTheDocument()
    })

    it('hides Ollama Cloud fields when provider is Gemini (default)', () => {
      render(<Settings />)
      // Key field and model input should NOT be visible in Gemini mode
      expect(screen.queryByLabelText('Ollama Cloud API Key')).not.toBeInTheDocument()
      expect(screen.queryByLabelText('Ollama Cloud Model')).not.toBeInTheDocument()
    })

    it('reveals key field and model input when Ollama Cloud is chosen', async () => {
      render(<Settings />)

      await act(async () => {
        fireEvent.click(screen.getByLabelText('Use Ollama Cloud summarization provider'))
      })

      expect(screen.getByLabelText('Ollama Cloud API Key')).toBeInTheDocument()
      expect(screen.getByLabelText('Ollama Cloud Model')).toBeInTheDocument()
    })

    it('calls updateConfig("summarization", ...) with ollama-cloud provider, key, and model on Save', async () => {
      render(<Settings />)

      await act(async () => {
        fireEvent.click(screen.getByLabelText('Use Ollama Cloud summarization provider'))
      })

      const keyInput = screen.getByLabelText('Ollama Cloud API Key') as HTMLInputElement
      fireEvent.change(keyInput, { target: { value: 'ok-1234567890' } })

      const modelInput = screen.getByLabelText('Ollama Cloud Model') as HTMLInputElement
      fireEvent.change(modelInput, { target: { value: 'gpt-oss:120b' } })

      await act(async () => {
        fireEvent.click(screen.getByLabelText('Save summarization settings'))
      })

      expect(mockUpdateConfig).toHaveBeenCalledWith(
        'summarization',
        expect.objectContaining({
          provider: 'ollama-cloud',
          ollamaCloudApiKey: 'ok-1234567890',
          ollamaCloudModel: 'gpt-oss:120b'
        })
      )
    })

    it('calls listModels and populates a select when "Fetch models" is clicked', async () => {
      render(<Settings />)

      await act(async () => {
        fireEvent.click(screen.getByLabelText('Use Ollama Cloud summarization provider'))
      })

      // Fill in an API key — fetch must use this (unsaved) form key, not a persisted one
      const keyInput = screen.getByLabelText('Ollama Cloud API Key') as HTMLInputElement
      fireEvent.change(keyInput, { target: { value: 'ok-1234567890' } })

      await act(async () => {
        fireEvent.click(screen.getByLabelText('Fetch available Ollama Cloud models'))
      })

      // The form key is forwarded to the IPC so first-run fetch works before Save
      expect(mockListModels).toHaveBeenCalledWith('ok-1234567890')
      // After fetch, a select should appear with the model names
      expect(screen.getByText('gpt-oss:120b')).toBeInTheDocument()
    })

    it('calls testConnection and shows result via toast/error when "Test" is clicked', async () => {
      render(<Settings />)

      await act(async () => {
        fireEvent.click(screen.getByLabelText('Use Ollama Cloud summarization provider'))
      })

      // Fill in key and model — Test must reflect these (unsaved) form values, not stale saved ones
      const keyInput = screen.getByLabelText('Ollama Cloud API Key') as HTMLInputElement
      fireEvent.change(keyInput, { target: { value: 'ok-1234567890' } })
      const modelInput = screen.getByLabelText('Ollama Cloud Model') as HTMLInputElement
      fireEvent.change(modelInput, { target: { value: 'gpt-oss:120b' } })

      await act(async () => {
        fireEvent.click(screen.getByLabelText('Test Ollama Cloud connection'))
      })

      // The form key + model are forwarded to the IPC so Test checks what the user typed
      expect(mockTestConnection).toHaveBeenCalledWith('ok-1234567890', 'gpt-oss:120b')
    })
  })

  // Code-quality finding fix — asymmetric provider gating in validateConfig.
  // A non-empty invalid Gemini key left in local state must NOT block saving once
  // the active provider is openai-whisper (spec §5.6: the Whisper user must be able
  // to queue/retry without a valid Gemini key). The Gemini checks are now gated on
  // provider !== 'openai-whisper', mirroring the Whisper key gating.
  it('should save Whisper config even when the (hidden) Gemini key holds an invalid sk- value', async () => {
    render(<Settings />)

    // Simulate a user who pasted an sk- key into the Gemini field while on Gemini...
    const geminiKeyInput = screen.getByLabelText('Gemini API Key') as HTMLInputElement
    fireEvent.change(geminiKeyInput, { target: { value: 'sk-pasted-into-wrong-field-12345' } })

    // ...then switched the active provider to OpenAI Whisper (Gemini field now hidden)
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Use OpenAI Whisper ASR provider'))
    })

    const openaiKeyInput = screen.getByLabelText('OpenAI API Key') as HTMLInputElement
    fireEvent.change(openaiKeyInput, { target: { value: 'sk-test-key-1234567890' } })

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Save transcription settings'))
    })

    // Save must go through — not blocked by the invalid (hidden, inactive) Gemini key
    expect(mockUpdateConfig).toHaveBeenCalledWith(
      'transcription',
      expect.objectContaining({
        provider: 'openai-whisper',
        openaiApiKey: 'sk-test-key-1234567890'
      })
    )
  })
})
