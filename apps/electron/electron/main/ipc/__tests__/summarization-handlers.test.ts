/**
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ipcMain } from 'electron'
import { registerSummarizationHandlers } from '../summarization-handlers'

// Mock electron
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() }
}))

// Mock config service
const mockGetConfig = vi.fn()
vi.mock('../../services/config', () => ({
  getConfig: () => mockGetConfig()
}))

// Global fetch mock
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('Summarization IPC Handlers', () => {
  let handlers: Record<string, (...args: any[]) => any> = {}

  beforeEach(() => {
    vi.clearAllMocks()
    handlers = {}
    vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: (...args: any[]) => any) => {
      handlers[channel] = handler
      return undefined as any
    })
    mockGetConfig.mockReturnValue({
      summarization: {
        provider: 'ollama-cloud',
        ollamaCloudApiKey: 'test-ollama-key-12345',
        ollamaCloudModel: 'gpt-oss:120b'
      }
    })
    registerSummarizationHandlers()
  })

  it('should register summarization:listModels and summarization:testConnection handlers', () => {
    expect(ipcMain.handle).toHaveBeenCalledWith('summarization:listModels', expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith('summarization:testConnection', expect.any(Function))
  })

  // --- summarization:listModels ---

  describe('summarization:listModels', () => {
    it('GETs https://ollama.com/api/tags with Authorization: Bearer <key> and maps model names', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [{ name: 'gpt-oss:120b' }, { name: 'deepseek-v3.1:671b' }] })
      })

      const result = await handlers['summarization:listModels'](null)

      expect(mockFetch).toHaveBeenCalledWith(
        'https://ollama.com/api/tags',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({ Authorization: 'Bearer test-ollama-key-12345' })
        })
      )
      expect(result).toEqual({ success: true, models: ['gpt-oss:120b', 'deepseek-v3.1:671b'] })
    })

    it('returns { success: false, error } on non-OK response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized'
      })

      const result = await handlers['summarization:listModels'](null)

      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
    })

    it('returns { success: false, error } on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('network failure'))

      const result = await handlers['summarization:listModels'](null)

      expect(result.success).toBe(false)
      expect(result.error).toContain('network failure')
    })

    it('uses the key passed as an arg (unsaved form key) over the persisted config key', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [{ name: 'gpt-oss:120b' }] })
      })

      // Arg key differs from the persisted 'test-ollama-key-12345' in beforeEach.
      await handlers['summarization:listModels'](null, 'form-key-unsaved')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://ollama.com/api/tags',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer form-key-unsaved' })
        })
      )
    })
  })

  // --- summarization:testConnection ---

  describe('summarization:testConnection', () => {
    it('POSTs a 1-token chat and returns { success: true } on OK', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ message: { content: 'pong' } })
      })

      const result = await handlers['summarization:testConnection'](null)

      expect(mockFetch).toHaveBeenCalledWith(
        'https://ollama.com/api/chat',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: 'Bearer test-ollama-key-12345' })
        })
      )
      // Body should include the configured model and a ping message
      const callArgs = mockFetch.mock.calls[0]
      const body = JSON.parse(callArgs[1].body)
      expect(body.model).toBe('gpt-oss:120b')
      expect(body.messages).toEqual([{ role: 'user', content: 'ping' }])
      expect(result).toEqual({ success: true })
    })

    it('returns key-rejected message on 401', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized'
      })

      const result = await handlers['summarization:testConnection'](null)

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/key.*rejected|API key was rejected/i)
    })

    it('returns model-not-found message on 404 (spec §7.1 wording)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'Not Found'
      })

      const result = await handlers['summarization:testConnection'](null)

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/not found|choose a new model/i)
    })

    it('returns quota message on 429', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => 'Too Many Requests'
      })

      const result = await handlers['summarization:testConnection'](null)

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/quota|rate.?limit/i)
    })

    it('uses the key + model passed as args (unsaved form values) over the persisted config', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ message: { content: 'pong' } })
      })

      // Args differ from the persisted key/model in beforeEach.
      await handlers['summarization:testConnection'](null, 'form-key-unsaved', 'deepseek-v3.1:671b')

      const callArgs = mockFetch.mock.calls[0]
      const body = JSON.parse(callArgs[1].body)
      expect(callArgs[1].headers.Authorization).toBe('Bearer form-key-unsaved')
      expect(body.model).toBe('deepseek-v3.1:671b')
    })
  })
})
