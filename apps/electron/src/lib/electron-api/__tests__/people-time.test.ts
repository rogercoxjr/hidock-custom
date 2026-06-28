/**
 * people-time.test.ts — Shape-assertion tests for the 7 people-time SDK groups:
 *   meetings, contacts, projects, knowledge, syncedFiles, chat, calendar.
 *
 * Pattern: mock http; feed 2xx OR 4xx; assert EXACT returned shape per CONTRACTS.md.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeMeetingsGroup } from '../groups/meetings'
import { makeContactsGroup } from '../groups/contacts'
import { makeProjectsGroup } from '../groups/projects'
import { makeKnowledgeGroup } from '../groups/knowledge'
import { makeSyncedFilesGroup } from '../groups/syncedFiles'
import { makeChatGroup } from '../groups/chat'
import { makeCalendarGroup } from '../groups/calendar'
import type { Http } from '../http'

// ---------------------------------------------------------------------------
// Mock HTTP factory
// ---------------------------------------------------------------------------

function makeHttp() {
  return {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    del: vi.fn(),
  } as unknown as Http & {
    get: ReturnType<typeof vi.fn>
    post: ReturnType<typeof vi.fn>
    patch: ReturnType<typeof vi.fn>
    put: ReturnType<typeof vi.fn>
    del: ReturnType<typeof vi.fn>
  }
}

function ok2xx(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, data })
}

function err4xx(status = 400, error = 'Bad Request', data?: unknown) {
  return Promise.resolve({ ok: false, status, error, data })
}

// ---------------------------------------------------------------------------
// meetings
// ---------------------------------------------------------------------------

describe('makeMeetingsGroup', () => {
  let http: ReturnType<typeof makeHttp>
  let grp: ReturnType<typeof makeMeetingsGroup>

  beforeEach(() => {
    http = makeHttp()
    grp = makeMeetingsGroup({ http })
  })

  // RAW-THROW: getAll
  it('getAll 2xx → bare any[]', async () => {
    http.get.mockResolvedValueOnce(ok2xx([{ id: 'm1' }]))
    const result = await grp.getAll()
    expect(Array.isArray(result)).toBe(true)
    expect(result[0]).toEqual({ id: 'm1' })
  })

  it('getAll 4xx → throws', async () => {
    http.get.mockResolvedValueOnce(err4xx(500, 'Server Error'))
    await expect(grp.getAll()).rejects.toThrow('Server Error')
  })

  // RAW-THROW: getById
  it('getById 2xx → bare row', async () => {
    http.get.mockResolvedValueOnce(ok2xx({ id: 'm1', subject: 'Test' }))
    const result = await grp.getById('m1')
    expect(result).toEqual({ id: 'm1', subject: 'Test' })
  })

  it('getById 4xx → throws', async () => {
    http.get.mockResolvedValueOnce(err4xx(404, 'Not Found'))
    await expect(grp.getById('x')).rejects.toThrow('Not Found')
  })

  // RAW-THROW: getByIds
  it('getByIds 2xx → bare Record<string,any>', async () => {
    http.post.mockResolvedValueOnce(ok2xx({ m1: { id: 'm1' } }))
    const result = await grp.getByIds(['m1'])
    expect(result).toEqual({ m1: { id: 'm1' } })
  })

  it('getByIds 4xx → throws', async () => {
    http.post.mockResolvedValueOnce(err4xx(400, 'Bad Request'))
    await expect(grp.getByIds(['x'])).rejects.toThrow('Bad Request')
  })

  // RAW-THROW: getDetails
  it('getDetails 2xx → bare object', async () => {
    http.get.mockResolvedValueOnce(ok2xx({ id: 'm1', contacts: [] }))
    const result = await grp.getDetails('m1')
    expect(result).toEqual({ id: 'm1', contacts: [] })
  })

  it('getDetails 4xx → throws', async () => {
    http.get.mockResolvedValueOnce(err4xx(404, 'Not Found'))
    await expect(grp.getDetails('x')).rejects.toThrow('Not Found')
  })

  // RESULT: update
  it('update 2xx → {success:true, data}', async () => {
    http.patch.mockResolvedValueOnce(ok2xx({ id: 'm1', subject: 'Updated' }))
    const result = await grp.update({ id: 'm1', subject: 'Updated' })
    expect(result.success).toBe(true)
    expect((result as any).data).toEqual({ id: 'm1', subject: 'Updated' })
  })

  it('update 4xx → {success:false, error} (string)', async () => {
    http.patch.mockResolvedValueOnce(err4xx(400, 'Validation failed'))
    const result = await grp.update({ id: 'm1' })
    expect(result.success).toBe(false)
    expect(typeof (result as any).error).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// contacts  (RESULT; error synthesized as {message, details?})
// ---------------------------------------------------------------------------

describe('makeContactsGroup', () => {
  let http: ReturnType<typeof makeHttp>
  let grp: ReturnType<typeof makeContactsGroup>

  beforeEach(() => {
    http = makeHttp()
    grp = makeContactsGroup({ http })
  })

  it('getAll 2xx → {success:true, data:{contacts,total}}', async () => {
    http.get.mockResolvedValueOnce(ok2xx({ contacts: [{ id: 'c1' }], total: 1 }))
    const result = await grp.getAll()
    expect(result.success).toBe(true)
    expect((result as any).data.contacts[0]).toEqual({ id: 'c1' })
    expect((result as any).data.total).toBe(1)
  })

  it('getAll 4xx → {success:false, error:{message}}', async () => {
    http.get.mockResolvedValueOnce(err4xx(400, 'Bad Request', { details: { field: 'name' } }))
    const result = await grp.getAll()
    expect(result.success).toBe(false)
    const err = (result as any).error
    expect(typeof err?.message).toBe('string')
    expect(err?.details).toEqual({ field: 'name' })
  })

  it('getById 2xx → {success:true, data: ContactWithMeetings}', async () => {
    http.get.mockResolvedValueOnce(ok2xx({ id: 'c1', name: 'Alice', meetings: [] }))
    const result = await grp.getById('c1')
    expect(result.success).toBe(true)
    expect((result as any).data.id).toBe('c1')
  })

  it('getById 4xx → error.message synthesized', async () => {
    http.get.mockResolvedValueOnce(err4xx(404, 'Not Found'))
    const result = await grp.getById('x')
    expect(result.success).toBe(false)
    expect((result as any).error?.message).toBe('Not Found')
  })

  it('create 2xx → {success:true, data: Person}', async () => {
    http.post.mockResolvedValueOnce(ok2xx({ id: 'c1', name: 'Alice' }))
    const result = await grp.create({ name: 'Alice' })
    expect(result.success).toBe(true)
    expect((result as any).data.name).toBe('Alice')
  })

  it('update 4xx → error.message synthesized', async () => {
    http.patch.mockResolvedValueOnce(err4xx(422, 'Unprocessable'))
    const result = await grp.update({ id: 'c1' } as any)
    expect(result.success).toBe(false)
    expect((result as any).error?.message).toBeTruthy()
  })

  it('delete 2xx → {success:true}', async () => {
    http.del.mockResolvedValueOnce(ok2xx(null))
    const result = await grp.delete('c1')
    expect(result.success).toBe(true)
  })

  it('delete 4xx → {success:false, error:{message}}', async () => {
    http.del.mockResolvedValueOnce(err4xx(404, 'Not Found'))
    const result = await grp.delete('x')
    expect(result.success).toBe(false)
    expect((result as any).error?.message).toBe('Not Found')
  })

  it('getForMeeting 2xx → {success:true, data: Contact[]}', async () => {
    http.get.mockResolvedValueOnce(ok2xx([{ id: 'c1' }]))
    const result = await grp.getForMeeting('m1')
    expect(result.success).toBe(true)
    expect(Array.isArray((result as any).data)).toBe(true)
  })

  it('setSelf 2xx → {success:true, data: Person|null}', async () => {
    http.put.mockResolvedValueOnce(ok2xx({ id: 'c1', name: 'Me' }))
    const result = await grp.setSelf({ contactId: 'c1' })
    expect(result.success).toBe(true)
  })

  it('getSelf 2xx → {success:true}', async () => {
    http.get.mockResolvedValueOnce(ok2xx(null))
    const result = await grp.getSelf()
    expect(result.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// projects  (all RESULT; plain string error)
// ---------------------------------------------------------------------------

describe('makeProjectsGroup', () => {
  let http: ReturnType<typeof makeHttp>
  let grp: ReturnType<typeof makeProjectsGroup>

  beforeEach(() => {
    http = makeHttp()
    grp = makeProjectsGroup({ http })
  })

  it('getAll 2xx → {success:true, data}', async () => {
    http.get.mockResolvedValueOnce(ok2xx({ projects: [{ id: 'p1' }], total: 1 }))
    const result = await grp.getAll()
    expect(result.success).toBe(true)
    expect((result as any).data.projects[0]).toEqual({ id: 'p1' })
  })

  it('getAll 4xx → {success:false, error: string}', async () => {
    http.get.mockResolvedValueOnce(err4xx(500, 'Server Error'))
    const result = await grp.getAll()
    expect(result.success).toBe(false)
    expect(typeof (result as any).error).toBe('string')
  })

  it('getById 2xx → {success:true, data}', async () => {
    http.get.mockResolvedValueOnce(ok2xx({ id: 'p1', name: 'Proj' }))
    const result = await grp.getById('p1')
    expect(result.success).toBe(true)
  })

  it('create 2xx → {success:true, data: Project}', async () => {
    http.post.mockResolvedValueOnce(ok2xx({ id: 'p1', name: 'New' }))
    const result = await grp.create({ name: 'New' } as any)
    expect(result.success).toBe(true)
    expect((result as any).data.id).toBe('p1')
  })

  it('update 4xx → {success:false}', async () => {
    http.patch.mockResolvedValueOnce(err4xx(400, 'Bad'))
    const result = await grp.update({ id: 'p1' } as any)
    expect(result.success).toBe(false)
  })

  it('delete 2xx → {success:true}', async () => {
    http.del.mockResolvedValueOnce(ok2xx(null))
    const result = await grp.delete('p1')
    expect(result.success).toBe(true)
  })

  it('tagMeeting 2xx → {success:true}', async () => {
    http.post.mockResolvedValueOnce(ok2xx(null))
    const result = await grp.tagMeeting({ meetingId: 'm1', projectId: 'p1' } as any)
    expect(result.success).toBe(true)
  })

  it('untagMeeting 4xx → {success:false}', async () => {
    http.del.mockResolvedValueOnce(err4xx(404, 'Not Found'))
    const result = await grp.untagMeeting({ meetingId: 'm1', projectId: 'p1' } as any)
    expect(result.success).toBe(false)
  })

  it('getForMeeting 2xx → {success:true, data: Project[]}', async () => {
    http.get.mockResolvedValueOnce(ok2xx([{ id: 'p1' }]))
    const result = await grp.getForMeeting('m1')
    expect(result.success).toBe(true)
    expect(Array.isArray((result as any).data)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// knowledge
// ---------------------------------------------------------------------------

describe('makeKnowledgeGroup', () => {
  let http: ReturnType<typeof makeHttp>
  let grp: ReturnType<typeof makeKnowledgeGroup>

  beforeEach(() => {
    http = makeHttp()
    grp = makeKnowledgeGroup({ http })
  })

  // RAW-THROW: getAll
  it('getAll 2xx → bare KnowledgeCapture[]', async () => {
    http.get.mockResolvedValueOnce(ok2xx([{ id: 'k1' }]))
    const result = await grp.getAll()
    expect(Array.isArray(result)).toBe(true)
    expect(result[0]).toEqual({ id: 'k1' })
  })

  it('getAll 4xx → throws', async () => {
    http.get.mockResolvedValueOnce(err4xx(500, 'Server Error'))
    await expect(grp.getAll()).rejects.toThrow('Server Error')
  })

  // RAW-THROW: getById
  it('getById 2xx → bare row or null', async () => {
    http.get.mockResolvedValueOnce(ok2xx({ id: 'k1', title: 'T' }))
    const result = await grp.getById('k1')
    expect((result as any).id).toBe('k1')
  })

  it('getById 4xx → throws', async () => {
    http.get.mockResolvedValueOnce(err4xx(404, 'Not Found'))
    await expect(grp.getById('x')).rejects.toThrow('Not Found')
  })

  // RAW-THROW: getByIds
  it('getByIds 2xx → bare KnowledgeCapture[]', async () => {
    http.post.mockResolvedValueOnce(ok2xx([{ id: 'k1' }]))
    const result = await grp.getByIds(['k1'])
    expect(result[0]).toEqual({ id: 'k1' })
  })

  it('getByIds 4xx → throws', async () => {
    http.post.mockResolvedValueOnce(err4xx(400, 'Bad Request'))
    await expect(grp.getByIds(['x'])).rejects.toThrow('Bad Request')
  })

  // INLINE: update
  it('update 2xx → {success:true}', async () => {
    http.patch.mockResolvedValueOnce(ok2xx({ id: 'k1' }))
    const result = await grp.update('k1', { title: 'New' } as any)
    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('update 4xx → {success:false, error: string}', async () => {
    http.patch.mockResolvedValueOnce(err4xx(400, 'Bad Request'))
    const result = await grp.update('k1', {})
    expect(result.success).toBe(false)
    expect(typeof result.error).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// syncedFiles
// ---------------------------------------------------------------------------

describe('makeSyncedFilesGroup', () => {
  let http: ReturnType<typeof makeHttp>
  let grp: ReturnType<typeof makeSyncedFilesGroup>

  beforeEach(() => {
    http = makeHttp()
    grp = makeSyncedFilesGroup({ http })
  })

  // BOOL: isFileSynced
  it('isFileSynced 2xx → true', async () => {
    http.get.mockResolvedValueOnce(ok2xx({ synced: true }))
    const result = await grp.isFileSynced('test.wav')
    expect(result).toBe(true)
  })

  it('isFileSynced 4xx → false', async () => {
    http.get.mockResolvedValueOnce(err4xx(404, 'Not Found'))
    const result = await grp.isFileSynced('missing.wav')
    expect(result).toBe(false)
  })

  // BOOL: remove
  it('remove 2xx → true', async () => {
    http.del.mockResolvedValueOnce(ok2xx(null))
    const result = await grp.remove('test.wav')
    expect(result).toBe(true)
  })

  it('remove 4xx → false', async () => {
    http.del.mockResolvedValueOnce(err4xx(404, 'Not Found'))
    const result = await grp.remove('x.wav')
    expect(result).toBe(false)
  })

  // RAW-THROW: getSyncedFile
  it('getSyncedFile 2xx with data → row object', async () => {
    const row = { id: 'sf1', original_filename: 'a.wav', local_filename: 'a.wav', file_path: '/p/a.wav', synced_at: '2026-01-01' }
    http.get.mockResolvedValueOnce(ok2xx(row))
    const result = await grp.getSyncedFile('a.wav')
    expect(result).toEqual(row)
  })

  it('getSyncedFile 2xx with null body → undefined', async () => {
    http.get.mockResolvedValueOnce(ok2xx(null))
    const result = await grp.getSyncedFile('a.wav')
    expect(result).toBeUndefined()
  })

  it('getSyncedFile 4xx → throws', async () => {
    http.get.mockResolvedValueOnce(err4xx(500, 'Error'))
    await expect(grp.getSyncedFile('x.wav')).rejects.toThrow('Error')
  })

  // RAW-THROW: getAll
  it('getAll 2xx → bare array', async () => {
    http.get.mockResolvedValueOnce(ok2xx([{ id: 'sf1' }]))
    const result = await grp.getAll()
    expect(Array.isArray(result)).toBe(true)
    expect(result[0]).toEqual({ id: 'sf1' })
  })

  it('getAll 4xx → throws', async () => {
    http.get.mockResolvedValueOnce(err4xx(500, 'Server Error'))
    await expect(grp.getAll()).rejects.toThrow('Server Error')
  })

  // RAW-THROW: add
  it('add 2xx → bare id string', async () => {
    http.post.mockResolvedValueOnce(ok2xx({ id: 'sf42' }))
    const result = await grp.add('a.wav', 'a-local.wav', '/p/a.wav', 1024)
    expect(result).toBe('sf42')
  })

  it('add 4xx → throws', async () => {
    http.post.mockResolvedValueOnce(err4xx(400, 'Conflict'))
    await expect(grp.add('a.wav', 'a.wav', '/p/a.wav')).rejects.toThrow('Conflict')
  })

  // RAW-THROW: getFilenames
  it('getFilenames 2xx → bare string[]', async () => {
    http.get.mockResolvedValueOnce(ok2xx(['a.wav', 'b.wav']))
    const result = await grp.getFilenames()
    expect(result).toEqual(['a.wav', 'b.wav'])
  })

  it('getFilenames 4xx → throws', async () => {
    http.get.mockResolvedValueOnce(err4xx(500, 'Error'))
    await expect(grp.getFilenames()).rejects.toThrow('Error')
  })
})

// ---------------------------------------------------------------------------
// chat
// ---------------------------------------------------------------------------

describe('makeChatGroup', () => {
  let http: ReturnType<typeof makeHttp>
  let grp: ReturnType<typeof makeChatGroup>

  beforeEach(() => {
    http = makeHttp()
    grp = makeChatGroup({ http })
  })

  // RAW-THROW: getHistory
  it('getHistory 2xx → bare any[]', async () => {
    http.get.mockResolvedValueOnce(ok2xx([{ id: 'ch1', role: 'user' }]))
    const result = await grp.getHistory()
    expect(Array.isArray(result)).toBe(true)
    expect(result[0].role).toBe('user')
  })

  it('getHistory 4xx → throws', async () => {
    http.get.mockResolvedValueOnce(err4xx(500, 'Error'))
    await expect(grp.getHistory()).rejects.toThrow('Error')
  })

  // RAW-THROW: addMessage
  it('addMessage 2xx → bare row', async () => {
    http.post.mockResolvedValueOnce(ok2xx({ id: 'ch1', role: 'user', content: 'hi' }))
    const result = await grp.addMessage('user', 'hi')
    expect((result as any).id).toBe('ch1')
  })

  it('addMessage 4xx → throws', async () => {
    http.post.mockResolvedValueOnce(err4xx(400, 'Bad'))
    await expect(grp.addMessage('user', '')).rejects.toThrow('Bad')
  })

  // BOOL: clearHistory
  it('clearHistory 2xx → true', async () => {
    http.del.mockResolvedValueOnce(ok2xx(null))
    const result = await grp.clearHistory()
    expect(result).toBe(true)
  })

  it('clearHistory 4xx → false', async () => {
    http.del.mockResolvedValueOnce(err4xx(500, 'Error'))
    const result = await grp.clearHistory()
    expect(result).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// calendar  (all RAW-THROW)
// ---------------------------------------------------------------------------

describe('makeCalendarGroup', () => {
  let http: ReturnType<typeof makeHttp>
  let grp: ReturnType<typeof makeCalendarGroup>

  beforeEach(() => {
    http = makeHttp()
    grp = makeCalendarGroup({ http })
  })

  it('sync 2xx → bare any', async () => {
    http.post.mockResolvedValueOnce(ok2xx({ synced: 5 }))
    const result = await grp.sync()
    expect((result as any).synced).toBe(5)
  })

  it('sync 4xx → throws', async () => {
    http.post.mockResolvedValueOnce(err4xx(500, 'Error'))
    await expect(grp.sync()).rejects.toThrow('Error')
  })

  it('clearAndSync 2xx → bare any', async () => {
    http.post.mockResolvedValueOnce(ok2xx({ synced: 3 }))
    const result = await grp.clearAndSync()
    expect((result as any).synced).toBe(3)
  })

  it('clearAndSync 4xx → throws', async () => {
    http.post.mockResolvedValueOnce(err4xx(500, 'Error'))
    await expect(grp.clearAndSync()).rejects.toThrow('Error')
  })

  it('getLastSync 2xx → string|null', async () => {
    http.get.mockResolvedValueOnce(ok2xx('2026-01-01T00:00:00Z'))
    const result = await grp.getLastSync()
    expect(typeof result).toBe('string')
  })

  it('getLastSync 4xx → throws', async () => {
    http.get.mockResolvedValueOnce(err4xx(500, 'Error'))
    await expect(grp.getLastSync()).rejects.toThrow('Error')
  })

  it('setUrl 2xx → bare any', async () => {
    http.patch.mockResolvedValueOnce(ok2xx({ ok: true }))
    const result = await grp.setUrl('http://cal.example.com/feed')
    expect((result as any).ok).toBe(true)
  })

  it('toggleAutoSync 2xx → bare any', async () => {
    http.patch.mockResolvedValueOnce(ok2xx({ autoSync: true }))
    const result = await grp.toggleAutoSync(true)
    expect((result as any).autoSync).toBe(true)
  })

  it('setInterval 2xx → bare any', async () => {
    http.patch.mockResolvedValueOnce(ok2xx({ interval: 30 }))
    const result = await grp.setInterval(30)
    expect((result as any).interval).toBe(30)
  })

  it('getSettings 2xx → bare any', async () => {
    http.get.mockResolvedValueOnce(ok2xx({ url: 'http://cal.example.com', autoSync: true }))
    const result = await grp.getSettings()
    expect((result as any).autoSync).toBe(true)
  })

  it('getSettings 4xx → throws', async () => {
    http.get.mockResolvedValueOnce(err4xx(500, 'Error'))
    await expect(grp.getSettings()).rejects.toThrow('Error')
  })
})
