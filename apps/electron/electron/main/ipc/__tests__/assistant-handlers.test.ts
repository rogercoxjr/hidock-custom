
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerAssistantHandlers } from '../assistant-handlers'
import { ipcMain } from 'electron'
import { run, runNoSave, queryOne, runInTransaction } from '../../services/database'

// Mock electron
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  },
  app: {
    getPath: vi.fn(() => '/tmp/test-hidock')
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn()
  }
}))

// Mock database
vi.mock('../../services/database', () => ({
  queryAll: vi.fn(),
  queryOne: vi.fn(),
  run: vi.fn(),
  runNoSave: vi.fn(),
  runInTransaction: vi.fn((fn) => fn())
}))

describe('Assistant IPC Handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should register handlers', () => {
    registerAssistantHandlers()
    expect(ipcMain.handle).toHaveBeenCalledWith('assistant:getConversations', expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith('assistant:createConversation', expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith('assistant:deleteConversation', expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith('assistant:getMessages', expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith('assistant:addMessage', expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith('assistant:addContext', expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith('assistant:removeContext', expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith('assistant:getContext', expect.any(Function))
  })

  // Regression: addMessage must write INSIDE the transaction via runNoSave, not the
  // auto-saving run(). run() calls saveDatabase()/db.export() per statement, which ends
  // the open transaction so runInTransaction's COMMIT/ROLLBACK throw
  // "cannot rollback - no transaction is active" — the bug that broke the assistant.
  it('addMessage writes via runNoSave inside the transaction (not the auto-saving run)', async () => {
    const handlers: Record<string, (...args: any[]) => any> = {}
    ;(ipcMain.handle as any).mockImplementation((channel: string, fn: any) => {
      handlers[channel] = fn
    })
    ;(queryOne as any)
      .mockReturnValueOnce({ id: 'conv-1' }) // conversation-exists check
      .mockReturnValueOnce({
        id: 'msg-1',
        conversation_id: 'conv-1',
        role: 'user',
        content: 'hi',
        sources: null,
        created_at: '2026-06-23T00:00:00.000Z'
      })

    registerAssistantHandlers()
    await handlers['assistant:addMessage'](null, 'conv-1', 'user', 'hi')

    // Both writes go through the transaction-safe runNoSave...
    expect(runNoSave).toHaveBeenCalledTimes(2)
    expect(runNoSave).toHaveBeenNthCalledWith(1, expect.stringContaining('INSERT INTO chat_messages'), expect.any(Array))
    expect(runNoSave).toHaveBeenNthCalledWith(2, expect.stringContaining('UPDATE conversations'), expect.any(Array))
    // ...and the auto-saving run() is NOT used inside the transaction.
    expect(run).not.toHaveBeenCalled()
    expect(runInTransaction).toHaveBeenCalledTimes(1)
  })
})
