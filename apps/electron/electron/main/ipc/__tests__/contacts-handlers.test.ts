
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerContactsHandlers } from '../contacts-handlers'
import { ipcMain } from 'electron'

// Mock electron ipcMain
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

// Mock database
vi.mock('../../services/database', () => ({
  queryAll: vi.fn(),
  queryOne: vi.fn(),
  run: vi.fn(),
  runInTransaction: vi.fn((fn) => fn()),
  getContacts: vi.fn(),
  getContactById: vi.fn(),
  updateContact: vi.fn(),
  deleteContact: vi.fn(),
  getMeetingsForContact: vi.fn(),
  getContactsForMeeting: vi.fn(),
  upsertContact: vi.fn(),
  setSelfContact: vi.fn(),
  clearSelfContact: vi.fn(),
  getSelfContactId: vi.fn(),
  getDatabase: vi.fn(() => ({
    prepare: vi.fn(() => ({
      bind: vi.fn(),
      step: vi.fn(),
      getAsObject: vi.fn(),
      free: vi.fn()
    }))
  }))
}))

describe('Contacts IPC Handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should register all handlers including delete', () => {
    registerContactsHandlers()
    expect(ipcMain.handle).toHaveBeenCalledWith('contacts:getAll', expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith('contacts:getById', expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith('contacts:update', expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith('contacts:delete', expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith('contacts:getForMeeting', expect.any(Function))
  })

  it('should map database row to Person interface including new fields', async () => {
    const { getContacts } = await import('../../services/database')
    const mockRow = {
      id: 'p1',
      name: 'Mario',
      email: 'mario@example.com',
      type: 'team',
      role: 'Dev',
      company: 'HiDock',
      notes: 'Notes',
      tags: '["tag1"]',
      firstSeenAt: '2025-01-01',
      lastSeenAt: '2025-01-02',
      meetingCount: 5,
      createdAt: '2025-01-01'
    }

    vi.mocked(getContacts).mockReturnValue({
      contacts: [mockRow as any],
      total: 1
    })

    registerContactsHandlers()
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(call => call[0] === 'contacts:getAll')?.[1]
    const result = await handler?.({} as any, {}) as any

    const person = result.data.contacts[0]
    expect(person.type).toBe('team')
    expect(person.role).toBe('Dev')
    expect(person.company).toBe('HiDock')
    expect(person.tags).toEqual(['tag1'])
  })

  it('should update contact name and email (B-PPL-003)', async () => {
    const { getContactById, updateContact } = await import('../../services/database')
    const mockContact = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'Old Name',
      email: 'old@example.com',
      type: 'team',
      role: null,
      company: null,
      notes: null,
      tags: null,
      first_seen_at: '2025-01-01',
      last_seen_at: '2025-01-02',
      meeting_count: 1,
      created_at: '2025-01-01'
    }

    vi.mocked(getContactById).mockReturnValue(mockContact as any)

    registerContactsHandlers()
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(call => call[0] === 'contacts:update')?.[1]
    await handler?.({} as any, {
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'New Name',
      email: 'new@example.com'
    }) as any

    expect(updateContact).toHaveBeenCalledWith(
      '550e8400-e29b-41d4-a716-446655440000',
      expect.objectContaining({ name: 'New Name', email: 'new@example.com' })
    )
  })

  it('should delete a contact (B-PPL-004)', async () => {
    const { getContactById, deleteContact } = await import('../../services/database')
    const mockContact = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'Test',
      email: null,
      type: 'unknown',
      role: null,
      company: null,
      notes: null,
      tags: null,
      first_seen_at: '2025-01-01',
      last_seen_at: '2025-01-02',
      meeting_count: 0,
      created_at: '2025-01-01'
    }

    vi.mocked(getContactById).mockReturnValue(mockContact as any)

    registerContactsHandlers()
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(call => call[0] === 'contacts:delete')?.[1]
    const result = await handler?.({} as any, '550e8400-e29b-41d4-a716-446655440000') as any

    expect(result.success).toBe(true)
    expect(deleteContact).toHaveBeenCalledWith('550e8400-e29b-41d4-a716-446655440000')
  })

  it('should return NOT_FOUND when deleting non-existent contact', async () => {
    const { getContactById } = await import('../../services/database')
    vi.mocked(getContactById).mockReturnValue(undefined)

    registerContactsHandlers()
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(call => call[0] === 'contacts:delete')?.[1]
    const result = await handler?.({} as any, '550e8400-e29b-41d4-a716-446655440000') as any

    expect(result.success).toBe(false)
    expect(result.error.code).toBe('NOT_FOUND')
  })

  it('should register contacts:create handler (AC2)', () => {
    registerContactsHandlers()
    expect(ipcMain.handle).toHaveBeenCalledWith('contacts:create', expect.any(Function))
  })

  it('creates a contact with a required name and returns a Person (AC2)', async () => {
    const { upsertContact } = await import('../../services/database')
    // Return a raw DB Contact row (snake_case) so the test proves mapToPerson ran
    // by asserting the camelCase Person-only fields it produces.
    vi.mocked(upsertContact).mockImplementation((c: any) => ({
      id: c.id,
      name: c.name,
      email: c.email,
      type: c.type ?? 'unknown',
      role: c.role ?? null,
      company: c.company ?? null,
      notes: c.notes ?? null,
      tags: c.tags ?? null,
      first_seen_at: '2026-06-17T00:00:00.000Z',
      last_seen_at: '2026-06-17T00:00:00.000Z',
      meeting_count: 0,
      is_self: 0,
      created_at: '2026-06-17T00:00:00.000Z'
    }))

    registerContactsHandlers()
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(call => call[0] === 'contacts:create')?.[1]
    const result = await handler?.({} as any, { name: 'Speaker A', email: 'a@example.com' }) as any

    expect(result.success).toBe(true)
    expect(result.data.name).toBe('Speaker A')
    expect(result.data.email).toBe('a@example.com')
    expect(typeof result.data.id).toBe('string')
    expect(result.data.id.length).toBeGreaterThan(0)
    // Person-only camelCase fields — present only if mapToPerson ran (not on the raw Contact)
    expect(result.data.firstSeenAt).toBe('2026-06-17T00:00:00.000Z')
    expect(result.data.lastSeenAt).toBe('2026-06-17T00:00:00.000Z')
    expect(result.data.interactionCount).toBe(0)
    expect(result.data.createdAt).toBe('2026-06-17T00:00:00.000Z')
    expect(result.data.tags).toEqual([])
    expect(upsertContact).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Speaker A', email: 'a@example.com' })
    )
  })

  it('rejects contacts:create with a missing/blank name (AC2)', async () => {
    const { upsertContact } = await import('../../services/database')
    registerContactsHandlers()
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(call => call[0] === 'contacts:create')?.[1]
    const result = await handler?.({} as any, { name: '   ' }) as any

    expect(result.success).toBe(false)
    expect(result.error.code).toBe('VALIDATION_ERROR')
    expect(upsertContact).not.toHaveBeenCalled()
  })

  it('allows duplicate emails on contacts:create (AC2)', async () => {
    const { upsertContact } = await import('../../services/database')
    vi.mocked(upsertContact).mockImplementation((c: any) => ({
      ...c, type: 'unknown', role: null, company: null, notes: null, created_at: '2026-06-17T00:00:00.000Z'
    }))

    registerContactsHandlers()
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(call => call[0] === 'contacts:create')?.[1]
    const r1 = await handler?.({} as any, { name: 'Alice', email: 'dup@example.com' }) as any
    const r2 = await handler?.({} as any, { name: 'Alice (other)', email: 'dup@example.com' }) as any

    expect(r1.success).toBe(true)
    expect(r2.success).toBe(true)
    expect(upsertContact).toHaveBeenCalledTimes(2)
  })

  it('contacts:setSelf with a contact id calls setSelfContact and returns a Person with isSelf true', async () => {
    const { setSelfContact, getContactById } = await import('../../services/database')
    const mockContact = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'Me',
      email: 'me@example.com',
      type: 'team',
      role: null,
      company: null,
      notes: null,
      tags: null,
      first_seen_at: '2025-01-01',
      last_seen_at: '2025-01-02',
      meeting_count: 0,
      is_self: 1,
      created_at: '2025-01-01'
    }
    vi.mocked(getContactById).mockReturnValue(mockContact as any)

    registerContactsHandlers()
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(call => call[0] === 'contacts:setSelf')?.[1]
    const result = await handler?.({} as any, { contactId: '550e8400-e29b-41d4-a716-446655440000' }) as any

    expect(result.success).toBe(true)
    expect(setSelfContact).toHaveBeenCalledWith('550e8400-e29b-41d4-a716-446655440000')
    expect(result.data.id).toBe('550e8400-e29b-41d4-a716-446655440000')
    expect(result.data.isSelf).toBe(true)
  })

  it('contacts:setSelf with null calls clearSelfContact and returns success(null)', async () => {
    const { clearSelfContact } = await import('../../services/database')

    registerContactsHandlers()
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(call => call[0] === 'contacts:setSelf')?.[1]
    const result = await handler?.({} as any, { contactId: null }) as any

    expect(result.success).toBe(true)
    expect(result.data).toBeNull()
    expect(clearSelfContact).toHaveBeenCalled()
  })

  it('contacts:getSelf returns the mapped self Person or null when not set', async () => {
    const { getSelfContactId, getContactById } = await import('../../services/database')
    const selfId = '550e8400-e29b-41d4-a716-446655440000'
    const mockContact = {
      id: selfId,
      name: 'Me',
      email: 'me@example.com',
      type: 'team',
      role: null,
      company: null,
      notes: null,
      tags: null,
      first_seen_at: '2025-01-01',
      last_seen_at: '2025-01-02',
      meeting_count: 0,
      is_self: 1,
      created_at: '2025-01-01'
    }
    vi.mocked(getSelfContactId).mockReturnValue(selfId)
    vi.mocked(getContactById).mockReturnValue(mockContact as any)

    registerContactsHandlers()
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(call => call[0] === 'contacts:getSelf')?.[1]

    const result = await handler?.({} as any) as any
    expect(result.success).toBe(true)
    expect(result.data).not.toBeNull()
    expect(result.data.id).toBe(selfId)
    expect(result.data.isSelf).toBe(true)

    vi.mocked(getSelfContactId).mockReturnValue(null)
    const emptyResult = await handler?.({} as any) as any
    expect(emptyResult.success).toBe(true)
    expect(emptyResult.data).toBeNull()
  })

  it('mapToPerson maps a contact with is_self=1 to isSelf:true', async () => {
    const { getContacts } = await import('../../services/database')
    const mockRow = {
      id: 'p1',
      name: 'Me',
      email: 'me@example.com',
      type: 'team',
      role: null,
      company: null,
      notes: null,
      tags: null,
      first_seen_at: '2025-01-01',
      last_seen_at: '2025-01-02',
      meeting_count: 0,
      is_self: 1,
      created_at: '2025-01-01'
    }

    vi.mocked(getContacts).mockReturnValue({
      contacts: [mockRow as any],
      total: 1
    })

    registerContactsHandlers()
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(call => call[0] === 'contacts:getAll')?.[1]
    const result = await handler?.({} as any, {}) as any

    expect(result.data.contacts[0].isSelf).toBe(true)
  })
})
