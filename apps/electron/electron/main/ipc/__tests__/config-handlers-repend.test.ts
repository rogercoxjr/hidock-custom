/**
 * Task 3 (auto-pipeline P4): Key-fix re-pend in config:update-section
 *
 * Tests that saving a changed provider API key in the transcription or
 * summarization section triggers rependFailedItems with the matching marker,
 * then calls processQueueManually. An unchanged key must trigger nothing.
 * A re-pend failure must NOT fail the config save (wrapped, logged).
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ipcMain } from 'electron'
import { registerConfigHandlers } from '../config-handlers'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() }
}))

// Track current in-memory config state across beforeEach/update calls
let currentConfig = {
  transcription: {
    provider: 'gemini',
    geminiApiKey: 'old-gemini-key',
    openaiApiKey: 'old-openai-key'
  },
  summarization: {
    provider: 'ollama-cloud',
    ollamaCloudApiKey: 'old-ollama-key'
  }
}

const mockGetConfig = vi.fn(() => currentConfig)
const mockUpdateConfig = vi.fn(async (section: string, values: Record<string, unknown>) => {
  // Simulate what real updateConfig does: merge the values into the section
  currentConfig = {
    ...currentConfig,
    [section]: { ...(currentConfig as Record<string, unknown>)[section] as object, ...values }
  } as typeof currentConfig
})

vi.mock('../../services/config', () => ({
  getConfig: () => mockGetConfig(),
  updateConfig: (...args: unknown[]) => mockUpdateConfig(args[0] as string, args[1] as Record<string, unknown>)
}))

const mockEmitActivityLog = vi.fn()
vi.mock('../../services/activity-log', () => ({
  emitActivityLog: (...args: unknown[]) => mockEmitActivityLog(...args)
}))

const mockRependFailedItems = vi.fn().mockReturnValue(0)
vi.mock('../../services/database', () => ({
  rependFailedItems: (...args: unknown[]) => mockRependFailedItems(...args)
}))

const mockProcessQueueManually = vi.fn().mockResolvedValue(undefined)
vi.mock('../../services/transcription', () => ({
  processQueueManually: () => mockProcessQueueManually()
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    transcription: {
      provider: 'gemini',
      geminiApiKey: 'old-gemini-key',
      openaiApiKey: 'old-openai-key'
    },
    summarization: {
      provider: 'ollama-cloud',
      ollamaCloudApiKey: 'old-ollama-key'
    },
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('config:update-section — key-fix re-pend (auto-pipeline P4 Task 3)', () => {
  let handlers: Record<string, (...args: any[]) => any> = {}

  beforeEach(() => {
    vi.clearAllMocks()
    handlers = {}

    // Reset config to the baseline state before each test
    currentConfig = makeConfig() as typeof currentConfig
    mockGetConfig.mockImplementation(() => currentConfig)
    mockUpdateConfig.mockImplementation(async (section: string, values: Record<string, unknown>) => {
      currentConfig = {
        ...currentConfig,
        [section]: { ...(currentConfig as Record<string, unknown>)[section] as object, ...values }
      } as typeof currentConfig
    })
    mockRependFailedItems.mockReturnValue(0)
    mockProcessQueueManually.mockResolvedValue(undefined)

    vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: (...args: any[]) => any) => {
      handlers[channel] = handler
      return undefined as ReturnType<typeof ipcMain.handle>
    })
    registerConfigHandlers()
  })

  it('changed openaiApiKey → rependFailedItems([\'OpenAI\']) + processQueueManually when count > 0', async () => {
    mockRependFailedItems.mockReturnValue(2) // 2 failed items matched

    const result = await handlers['config:update-section'](null, 'transcription', {
      openaiApiKey: 'new-openai-key'
    })

    expect(mockRependFailedItems).toHaveBeenCalledWith(['OpenAI'])
    expect(mockProcessQueueManually).toHaveBeenCalled()
    // Config save still succeeds
    expect((result as { success: boolean }).success).toBe(true)
  })

  it('changed geminiApiKey → rependFailedItems([\'Gemini API key\']) + processQueueManually when count > 0', async () => {
    mockRependFailedItems.mockReturnValue(1)

    await handlers['config:update-section'](null, 'transcription', {
      geminiApiKey: 'new-gemini-key'
    })

    expect(mockRependFailedItems).toHaveBeenCalledWith(['Gemini API key'])
    expect(mockProcessQueueManually).toHaveBeenCalled()
  })

  it('changed ollamaCloudApiKey → rependFailedItems([\'Ollama Cloud\']) + processQueueManually when count > 0', async () => {
    mockRependFailedItems.mockReturnValue(3)

    await handlers['config:update-section'](null, 'summarization', {
      ollamaCloudApiKey: 'new-ollama-key'
    })

    expect(mockRependFailedItems).toHaveBeenCalledWith(['Ollama Cloud'])
    expect(mockProcessQueueManually).toHaveBeenCalled()
  })

  it('does NOT call rependFailedItems when NO key field changes', async () => {
    // Saving a non-key field (e.g. provider) should not trigger re-pend
    await handlers['config:update-section'](null, 'transcription', {
      provider: 'openai-whisper'
    })

    expect(mockRependFailedItems).not.toHaveBeenCalled()
    expect(mockProcessQueueManually).not.toHaveBeenCalled()
  })

  it('does NOT call rependFailedItems when key value is unchanged', async () => {
    // Setting the key to the same value it already has
    await handlers['config:update-section'](null, 'transcription', {
      openaiApiKey: 'old-openai-key'  // same as baseline
    })

    expect(mockRependFailedItems).not.toHaveBeenCalled()
    expect(mockProcessQueueManually).not.toHaveBeenCalled()
  })

  it('does NOT call processQueueManually when rependFailedItems returns 0', async () => {
    // Key changed, but no matching failed items
    mockRependFailedItems.mockReturnValue(0)

    await handlers['config:update-section'](null, 'transcription', {
      openaiApiKey: 'new-openai-key'
    })

    expect(mockRependFailedItems).toHaveBeenCalledWith(['OpenAI'])
    // count was 0 → no queue kick
    expect(mockProcessQueueManually).not.toHaveBeenCalled()
  })

  it('does NOT emit re-pend activity log when count is 0', async () => {
    mockRependFailedItems.mockReturnValue(0)

    await handlers['config:update-section'](null, 'transcription', {
      openaiApiKey: 'new-openai-key'
    })

    // The "Settings updated" log still fires, but NO "Re-queued N failed transcriptions" log
    const reQueuedCalls = mockEmitActivityLog.mock.calls.filter(
      (call) => String(call[1]).includes('Re-queued')
    )
    expect(reQueuedCalls).toHaveLength(0)
  })

  it('re-pend failure does NOT fail the config save (wrapped, logged)', async () => {
    mockRependFailedItems.mockImplementation(() => {
      throw new Error('DB locked')
    })

    // The handler must NOT throw; the save should still succeed
    const result = await handlers['config:update-section'](null, 'transcription', {
      openaiApiKey: 'new-openai-key'
    })

    expect((result as { success: boolean }).success).toBe(true)
    // processQueueManually was NOT called because repend threw
    expect(mockProcessQueueManually).not.toHaveBeenCalled()
  })

  it('multiple keys changed simultaneously → all markers in one rependFailedItems call', async () => {
    mockRependFailedItems.mockReturnValue(5)

    // Changing both openaiApiKey and geminiApiKey at once
    await handlers['config:update-section'](null, 'transcription', {
      openaiApiKey: 'new-openai-key',
      geminiApiKey: 'new-gemini-key'
    })

    expect(mockRependFailedItems).toHaveBeenCalledWith(
      expect.arrayContaining(['OpenAI', 'Gemini API key'])
    )
    expect(mockRependFailedItems).toHaveBeenCalledTimes(1)
    expect(mockProcessQueueManually).toHaveBeenCalled()
  })

  it('changed key must be non-empty (blank key saves but does not trigger re-pend)', async () => {
    // Saving an empty string key should NOT trigger re-pend (user clearing the key)
    await handlers['config:update-section'](null, 'transcription', {
      openaiApiKey: ''  // clearing the key
    })

    expect(mockRependFailedItems).not.toHaveBeenCalled()
    expect(mockProcessQueueManually).not.toHaveBeenCalled()
  })
})
