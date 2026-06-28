/**
 * ai-outputs.test.ts — Shape-assertion tests for the 7 ai-outputs SDK groups:
 *   rag, assistant, actionables, outputs, summarization, summarizationTemplates, quality.
 *
 * Pattern: mock http; feed 2xx OR 4xx; assert EXACT returned shape per CONTRACTS.md.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeRagGroup } from '../groups/rag'
import { makeAssistantGroup } from '../groups/assistant'
import { makeActionablesGroup } from '../groups/actionables'
import { makeOutputsGroup } from '../groups/outputs'
import { makeSummarizationGroup } from '../groups/summarization'
import { makeSummarizationTemplatesGroup } from '../groups/summarizationTemplates'
import { makeQualityGroup } from '../groups/quality'
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
// rag
// ---------------------------------------------------------------------------

describe('makeRagGroup', () => {
  let http: ReturnType<typeof makeHttp>
  let grp: ReturnType<typeof makeRagGroup>

  beforeEach(() => {
    http = makeHttp()
    grp = makeRagGroup({ http })
  })

  // RESULT: status
  it('status 2xx → {success:true, data: RAGStatus}', async () => {
    http.get.mockResolvedValueOnce(ok2xx({ isIndexed: true, documentCount: 5 }))
    const result = await grp.status()
    expect(result.success).toBe(true)
    expect((result as any).data.documentCount).toBe(5)
  })

  it('status 4xx → {success:false, error:{message}}', async () => {
    http.get.mockResolvedValueOnce(err4xx(500, 'Server Error'))
    const result = await grp.status()
    expect(result.success).toBe(false)
    expect(typeof (result as any).error?.message).toBe('string')
  })

  // RESULT: chat
  it('chat 2xx → {success:true, data: RAGChatResponse}', async () => {
    http.post.mockResolvedValueOnce(ok2xx({ answer: 'Hello', sources: [] }))
    const result = await grp.chat({ sessionId: 's1', message: 'Hi' })
    expect(result.success).toBe(true)
    expect((result as any).data.answer).toBe('Hello')
  })

  it('chat 4xx → {success:false, error:{message}}', async () => {
    http.post.mockResolvedValueOnce(err4xx(400, 'Bad Request'))
    const result = await grp.chat({ sessionId: 's1', message: '' })
    expect(result.success).toBe(false)
    expect((result as any).error?.message).toBeTruthy()
  })

  // RESULT: globalSearch — reads error.message
  it('globalSearch 2xx → {success:true, data:{knowledge,people,projects}}', async () => {
    http.get.mockResolvedValueOnce(ok2xx({ knowledge: [{ id: 'k1' }], people: [], projects: [] }))
    const result = await grp.globalSearch('test')
    expect(result.success).toBe(true)
    expect(Array.isArray((result as any).data.knowledge)).toBe(true)
    expect(Array.isArray((result as any).data.people)).toBe(true)
  })

  it('globalSearch 4xx → {success:false, error:{message}}', async () => {
    http.get.mockResolvedValueOnce(err4xx(500, 'Server Error'))
    const result = await grp.globalSearch('test')
    expect(result.success).toBe(false)
    expect(typeof (result as any).error?.message).toBe('string')
  })

  // RESULT: cancel
  it('cancel 2xx → {success:true, data: boolean}', async () => {
    http.post.mockResolvedValueOnce(ok2xx(true))
    const result = await grp.cancel('s1')
    expect(result.success).toBe(true)
    expect((result as any).data).toBe(true)
  })

  it('cancel 4xx → {success:false}', async () => {
    http.post.mockResolvedValueOnce(err4xx(400, 'Error'))
    const result = await grp.cancel('s1')
    expect(result.success).toBe(false)
  })

  // RESULT: removeLastMessages
  it('removeLastMessages 2xx → {success:true, data: number}', async () => {
    http.post.mockResolvedValueOnce(ok2xx(2))
    const result = await grp.removeLastMessages('s1', 2)
    expect(result.success).toBe(true)
    expect((result as any).data).toBe(2)
  })

  // RESULT: clearSession
  it('clearSession 2xx → {success:true, data:undefined}', async () => {
    http.post.mockResolvedValueOnce(ok2xx(null))
    const result = await grp.clearSession('s1')
    expect(result.success).toBe(true)
  })

  // RAW-THROW: chatLegacy
  it('chatLegacy 2xx → bare {answer,sources}', async () => {
    http.post.mockResolvedValueOnce(ok2xx({ answer: 'Hi', sources: [{ content: 'c', score: 0.9 }] }))
    const result = await grp.chatLegacy('s1', 'Hello')
    expect(result.answer).toBe('Hi')
    expect(Array.isArray(result.sources)).toBe(true)
  })

  it('chatLegacy 4xx → throws', async () => {
    http.post.mockResolvedValueOnce(err4xx(500, 'Server Error'))
    await expect(grp.chatLegacy('s1', 'Hi')).rejects.toThrow('Server Error')
  })

  // RAW-THROW: stats
  it('stats 2xx → bare {documentCount,...}', async () => {
    http.get.mockResolvedValueOnce(ok2xx({ documentCount: 10, meetingCount: 5, sessionCount: 3 }))
    const result = await grp.stats()
    expect(result.documentCount).toBe(10)
  })

  it('stats 4xx → throws', async () => {
    http.get.mockResolvedValueOnce(err4xx(500, 'Error'))
    await expect(grp.stats()).rejects.toThrow('Error')
  })

  // RAW-THROW: getChunks
  it('getChunks 2xx → bare array', async () => {
    const chunk = { id: 'c1', content: 'text', chunkIndex: 0, embeddingDimensions: 384 }
    http.get.mockResolvedValueOnce(ok2xx([chunk]))
    const result = await grp.getChunks()
    expect(Array.isArray(result)).toBe(true)
    expect(result[0].id).toBe('c1')
  })

  it('getChunks 4xx → throws', async () => {
    http.get.mockResolvedValueOnce(err4xx(500, 'Error'))
    await expect(grp.getChunks()).rejects.toThrow('Error')
  })

  // RAW-THROW: search
  it('search 2xx → bare array', async () => {
    http.get.mockResolvedValueOnce(ok2xx([{ content: 'result', score: 0.8 }]))
    const result = await grp.search('query')
    expect(Array.isArray(result)).toBe(true)
    expect(result[0].score).toBe(0.8)
  })

  it('search 4xx → throws', async () => {
    http.get.mockResolvedValueOnce(err4xx(500, 'Error'))
    await expect(grp.search('q')).rejects.toThrow('Error')
  })

  // RAW-THROW: indexTranscript
  it('indexTranscript 2xx → bare {indexed}', async () => {
    http.post.mockResolvedValueOnce(ok2xx({ indexed: 3 }))
    const result = await grp.indexTranscript('transcript text', {})
    expect(result.indexed).toBe(3)
  })

  it('indexTranscript 4xx → throws', async () => {
    http.post.mockResolvedValueOnce(err4xx(400, 'Error'))
    await expect(grp.indexTranscript('text', {})).rejects.toThrow('Error')
  })

  // RESULT: summarizeMeeting
  it('summarizeMeeting 2xx → {success:true, data: string}', async () => {
    http.post.mockResolvedValueOnce(ok2xx('Summary text'))
    const result = await grp.summarizeMeeting('m1')
    expect(result.success).toBe(true)
    expect((result as any).data).toBe('Summary text')
  })

  // RESULT: findActionItems
  it('findActionItems 2xx → {success:true, data: string}', async () => {
    http.post.mockResolvedValueOnce(ok2xx('Action items'))
    const result = await grp.findActionItems()
    expect(result.success).toBe(true)
    expect((result as any).data).toBe('Action items')
  })
})

// ---------------------------------------------------------------------------
// assistant
// ---------------------------------------------------------------------------

describe('makeAssistantGroup', () => {
  let http: ReturnType<typeof makeHttp>
  let grp: ReturnType<typeof makeAssistantGroup>

  beforeEach(() => {
    http = makeHttp()
    grp = makeAssistantGroup({ http })
  })

  // RAW-THROW: getConversations
  it('getConversations 2xx → bare Conversation[]', async () => {
    http.get.mockResolvedValueOnce(ok2xx([{ id: 'c1', title: 'Test' }]))
    const result = await grp.getConversations()
    expect(Array.isArray(result)).toBe(true)
    expect(result[0].id).toBe('c1')
  })

  it('getConversations 4xx → throws', async () => {
    http.get.mockResolvedValueOnce(err4xx(500, 'Server Error'))
    await expect(grp.getConversations()).rejects.toThrow('Server Error')
  })

  // RAW-THROW: createConversation
  it('createConversation 2xx → bare Conversation (reads .id)', async () => {
    http.post.mockResolvedValueOnce(ok2xx({ id: 'c1', title: 'New Conv' }))
    const result = await grp.createConversation('New Conv')
    expect(result.id).toBe('c1')
  })

  it('createConversation 4xx → throws', async () => {
    http.post.mockResolvedValueOnce(err4xx(400, 'Bad'))
    await expect(grp.createConversation()).rejects.toThrow('Bad')
  })

  // RAW-THROW: getMessages
  it('getMessages 2xx → bare Message[]', async () => {
    http.get.mockResolvedValueOnce(ok2xx([{ id: 'm1', role: 'user', content: 'hi' }]))
    const result = await grp.getMessages('c1')
    expect(Array.isArray(result)).toBe(true)
    expect(result[0].id).toBe('m1')
  })

  it('getMessages 4xx → throws', async () => {
    http.get.mockResolvedValueOnce(err4xx(404, 'Not Found'))
    await expect(grp.getMessages('x')).rejects.toThrow('Not Found')
  })

  // RAW-THROW: addMessage
  it('addMessage 2xx → bare Message (reads .id)', async () => {
    http.post.mockResolvedValueOnce(ok2xx({ id: 'm42', role: 'user', content: 'hello' }))
    const result = await grp.addMessage('c1', 'user', 'hello')
    expect(result.id).toBe('m42')
  })

  it('addMessage 4xx → throws', async () => {
    http.post.mockResolvedValueOnce(err4xx(400, 'Bad'))
    await expect(grp.addMessage('c1', 'user', '')).rejects.toThrow('Bad')
  })

  // RAW-THROW: getContext
  it('getContext 2xx → bare string[]', async () => {
    http.get.mockResolvedValueOnce(ok2xx(['k1', 'k2']))
    const result = await grp.getContext('c1')
    expect(result).toEqual(['k1', 'k2'])
  })

  it('getContext 4xx → throws', async () => {
    http.get.mockResolvedValueOnce(err4xx(500, 'Error'))
    await expect(grp.getContext('c1')).rejects.toThrow('Error')
  })

  // INLINE: deleteConversation
  it('deleteConversation 2xx → {success:true}', async () => {
    http.del.mockResolvedValueOnce(ok2xx(null))
    const result = await grp.deleteConversation('c1')
    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('deleteConversation 4xx → {success:false, error}', async () => {
    http.del.mockResolvedValueOnce(err4xx(404, 'Not Found'))
    const result = await grp.deleteConversation('x')
    expect(result.success).toBe(false)
    expect(typeof result.error).toBe('string')
  })

  // INLINE: updateConversationTitle
  it('updateConversationTitle 2xx → {success:true}', async () => {
    http.patch.mockResolvedValueOnce(ok2xx(null))
    const result = await grp.updateConversationTitle('c1', 'New Title')
    expect(result.success).toBe(true)
  })

  it('updateConversationTitle 4xx → {success:false, error}', async () => {
    http.patch.mockResolvedValueOnce(err4xx(400, 'Bad'))
    const result = await grp.updateConversationTitle('c1', '')
    expect(result.success).toBe(false)
    expect(typeof result.error).toBe('string')
  })

  // INLINE: addContext
  it('addContext 2xx → {success:true}', async () => {
    http.post.mockResolvedValueOnce(ok2xx(null))
    const result = await grp.addContext('c1', 'k1')
    expect(result.success).toBe(true)
  })

  it('addContext 4xx → {success:false, error}', async () => {
    http.post.mockResolvedValueOnce(err4xx(400, 'Bad'))
    const result = await grp.addContext('c1', 'k1')
    expect(result.success).toBe(false)
    expect(typeof result.error).toBe('string')
  })

  // INLINE: removeContext
  it('removeContext 2xx → {success:true}', async () => {
    http.del.mockResolvedValueOnce(ok2xx(null))
    const result = await grp.removeContext('c1', 'k1')
    expect(result.success).toBe(true)
  })

  it('removeContext 4xx → {success:false, error}', async () => {
    http.del.mockResolvedValueOnce(err4xx(400, 'Bad'))
    const result = await grp.removeContext('c1', 'k1')
    expect(result.success).toBe(false)
    expect(typeof result.error).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// actionables
// ---------------------------------------------------------------------------

describe('makeActionablesGroup', () => {
  let http: ReturnType<typeof makeHttp>
  let grp: ReturnType<typeof makeActionablesGroup>

  beforeEach(() => {
    http = makeHttp()
    grp = makeActionablesGroup({ http })
  })

  // RAW-THROW: getAll
  it('getAll 2xx → bare Actionable[]', async () => {
    http.get.mockResolvedValueOnce(ok2xx([{ id: 'a1', title: 'Task' }]))
    const result = await grp.getAll()
    expect(Array.isArray(result)).toBe(true)
    expect(result[0].id).toBe('a1')
  })

  it('getAll 4xx → throws', async () => {
    http.get.mockResolvedValueOnce(err4xx(500, 'Error'))
    await expect(grp.getAll()).rejects.toThrow('Error')
  })

  // RAW-THROW: getByMeeting
  it('getByMeeting 2xx → bare Actionable[]', async () => {
    http.get.mockResolvedValueOnce(ok2xx([{ id: 'a1' }]))
    const result = await grp.getByMeeting('m1')
    expect(Array.isArray(result)).toBe(true)
    expect(result[0].id).toBe('a1')
  })

  it('getByMeeting 4xx → throws', async () => {
    http.get.mockResolvedValueOnce(err4xx(404, 'Not Found'))
    await expect(grp.getByMeeting('x')).rejects.toThrow('Not Found')
  })

  // INLINE: updateStatus
  it('updateStatus 2xx → {success:true}', async () => {
    http.patch.mockResolvedValueOnce(ok2xx(null))
    const result = await grp.updateStatus('a1', 'done')
    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('updateStatus 4xx → {success:false, error}', async () => {
    http.patch.mockResolvedValueOnce(err4xx(400, 'Bad'))
    const result = await grp.updateStatus('a1', 'invalid')
    expect(result.success).toBe(false)
    expect(typeof result.error).toBe('string')
  })

  // INLINE: generateOutput
  it('generateOutput 2xx → {success:true, data?}', async () => {
    http.post.mockResolvedValueOnce(ok2xx({ content: 'Generated output' }))
    const result = await grp.generateOutput('a1')
    expect(result.success).toBe(true)
    expect((result as any).data).toBeDefined()
  })

  it('generateOutput 4xx → {success:false, error}', async () => {
    http.post.mockResolvedValueOnce(err4xx(422, 'Unprocessable'))
    const result = await grp.generateOutput('a1')
    expect(result.success).toBe(false)
    expect(typeof result.error).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// outputs
// ---------------------------------------------------------------------------

describe('makeOutputsGroup', () => {
  let http: ReturnType<typeof makeHttp>
  let grp: ReturnType<typeof makeOutputsGroup>

  beforeEach(() => {
    http = makeHttp()
    grp = makeOutputsGroup({ http })
  })

  // RESULT: getTemplates
  it('getTemplates 2xx → {success:true, data: OutputTemplate[]}', async () => {
    http.get.mockResolvedValueOnce(ok2xx([{ id: 'meeting_minutes', name: 'Meeting Minutes' }]))
    const result = await grp.getTemplates()
    expect(result.success).toBe(true)
    expect(Array.isArray((result as any).data)).toBe(true)
  })

  it('getTemplates 4xx → {success:false, error:{message}}', async () => {
    http.get.mockResolvedValueOnce(err4xx(500, 'Server Error'))
    const result = await grp.getTemplates()
    expect(result.success).toBe(false)
    expect(typeof (result as any).error?.message).toBe('string')
  })

  // RESULT: generate — reads error.message
  it('generate 2xx → {success:true, data: GenerateOutputResponse}', async () => {
    http.post.mockResolvedValueOnce(ok2xx({ id: 'out1', content: 'Output text', templateId: 'meeting_minutes' }))
    const result = await grp.generate({ templateId: 'meeting_minutes', recordingId: 'r1' } as any)
    expect(result.success).toBe(true)
    expect((result as any).data.templateId).toBe('meeting_minutes')
  })

  it('generate 4xx → {success:false, error:{message}}', async () => {
    http.post.mockResolvedValueOnce(err4xx(400, 'Validation failed', { details: { field: 'templateId' } }))
    const result = await grp.generate({ templateId: 'meeting_minutes' } as any)
    expect(result.success).toBe(false)
    const err = (result as any).error
    expect(typeof err?.message).toBe('string')
    expect(err?.details).toEqual({ field: 'templateId' })
  })

  // RESULT: getByActionableId
  it('getByActionableId 2xx → {success:true, data}', async () => {
    http.get.mockResolvedValueOnce(ok2xx({ id: 'out1' }))
    const result = await grp.getByActionableId('a1')
    expect(result.success).toBe(true)
    expect((result as any).data.id).toBe('out1')
  })

  it('getByActionableId 4xx → {success:false, error:{message}}', async () => {
    http.get.mockResolvedValueOnce(err4xx(404, 'Not Found'))
    const result = await grp.getByActionableId('x')
    expect(result.success).toBe(false)
    expect(typeof (result as any).error?.message).toBe('string')
  })

  // DROPPED: copyToClipboard
  it('copyToClipboard → {success:false} (dropped/browser-native)', async () => {
    const result = await grp.copyToClipboard('text')
    expect(result.success).toBe(false)
  })

  // DROPPED: saveToFile
  it('saveToFile → {success:false} (dropped/browser-download)', async () => {
    const result = await grp.saveToFile('content', 'test.txt')
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// summarization (INLINE)
// ---------------------------------------------------------------------------

describe('makeSummarizationGroup', () => {
  let http: ReturnType<typeof makeHttp>
  let grp: ReturnType<typeof makeSummarizationGroup>

  beforeEach(() => {
    http = makeHttp()
    grp = makeSummarizationGroup({ http })
  })

  // INLINE: listModels → {success, models?, error?}
  it('listModels 2xx → {success:true, models:[...]}', async () => {
    http.get.mockResolvedValueOnce(ok2xx({ models: ['gpt-4o', 'claude-3-5-sonnet-20241022'] }))
    const result = await grp.listModels()
    expect(result.success).toBe(true)
    expect(Array.isArray(result.models)).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('listModels 4xx → {success:false, error: string}', async () => {
    http.get.mockResolvedValueOnce(err4xx(401, 'Unauthorized'))
    const result = await grp.listModels('bad-key')
    expect(result.success).toBe(false)
    expect(typeof result.error).toBe('string')
    expect(result.models).toBeUndefined()
  })

  // INLINE: testConnection → {success, error?}
  it('testConnection 2xx → {success:true}', async () => {
    http.post.mockResolvedValueOnce(ok2xx({ ok: true }))
    const result = await grp.testConnection()
    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('testConnection 4xx → {success:false, error: string}', async () => {
    http.post.mockResolvedValueOnce(err4xx(400, 'Connection failed', { details: { model: 'Invalid model' } }))
    const result = await grp.testConnection('key', 'bad-model')
    expect(result.success).toBe(false)
    expect(typeof result.error).toBe('string')
    // Zod details should be surfaced in the error message
    expect(result.error).toContain('Connection failed')
  })
})

// ---------------------------------------------------------------------------
// summarizationTemplates
// ---------------------------------------------------------------------------

describe('makeSummarizationTemplatesGroup', () => {
  let http: ReturnType<typeof makeHttp>
  let grp: ReturnType<typeof makeSummarizationTemplatesGroup>

  beforeEach(() => {
    http = makeHttp()
    grp = makeSummarizationTemplatesGroup({ http })
  })

  const mockTemplate = {
    id: 't1',
    name: 'Template 1',
    description: 'Desc',
    instructions: 'Do X',
    exampleTriggers: ['trigger'],
    isDefault: false,
    isBuiltin: false,
    enabled: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }

  // RESULT: list
  it('list 2xx → {success:true, data: SummarizationTemplate[]}', async () => {
    http.get.mockResolvedValueOnce(ok2xx([mockTemplate]))
    const result = await grp.list()
    expect(result.success).toBe(true)
    expect(Array.isArray((result as any).data)).toBe(true)
  })

  it('list 4xx → {success:false, error:{message}}', async () => {
    http.get.mockResolvedValueOnce(err4xx(500, 'Server Error'))
    const result = await grp.list()
    expect(result.success).toBe(false)
    expect(typeof (result as any).error?.message).toBe('string')
  })

  // RESULT: create
  it('create 2xx → {success:true, data: SummarizationTemplate}', async () => {
    http.post.mockResolvedValueOnce(ok2xx(mockTemplate))
    const result = await grp.create({ name: 'T1', instructions: 'Do X' })
    expect(result.success).toBe(true)
    expect((result as any).data.id).toBe('t1')
  })

  it('create 4xx → {success:false, error:{message}}', async () => {
    http.post.mockResolvedValueOnce(err4xx(422, 'Validation Error', { details: { name: 'Required' } }))
    const result = await grp.create({ name: '', instructions: '' })
    expect(result.success).toBe(false)
    const err = (result as any).error
    expect(typeof err?.message).toBe('string')
    expect(err?.details).toEqual({ name: 'Required' })
  })

  // RESULT: update
  it('update 2xx → {success:true, data}', async () => {
    http.patch.mockResolvedValueOnce(ok2xx({ ...mockTemplate, name: 'Updated' }))
    const result = await grp.update('t1', { name: 'Updated' })
    expect(result.success).toBe(true)
    expect((result as any).data.name).toBe('Updated')
  })

  // RESULT: setEnabled
  it('setEnabled 2xx → {success:true, data:true}', async () => {
    http.patch.mockResolvedValueOnce(ok2xx(null))
    const result = await grp.setEnabled('t1', false)
    expect(result.success).toBe(true)
    expect((result as any).data).toBe(true)
  })

  it('setEnabled 4xx → {success:false, error:{message}}', async () => {
    http.patch.mockResolvedValueOnce(err4xx(404, 'Not Found'))
    const result = await grp.setEnabled('x', true)
    expect(result.success).toBe(false)
    expect((result as any).error?.message).toBeTruthy()
  })

  // RESULT: delete
  it('delete 2xx → {success:true, data:true}', async () => {
    http.del.mockResolvedValueOnce(ok2xx(null))
    const result = await grp.delete('t1')
    expect(result.success).toBe(true)
    expect((result as any).data).toBe(true)
  })

  it('delete 4xx → {success:false, error:{message}}', async () => {
    http.del.mockResolvedValueOnce(err4xx(404, 'Not Found'))
    const result = await grp.delete('x')
    expect(result.success).toBe(false)
    expect((result as any).error?.message).toBeTruthy()
  })

  // RESULT: latestRun
  it('latestRun 2xx → {success:true, data: LatestRunView}', async () => {
    const view = { name: 'T1', confidence: 0.9, kind: 'applied', suggestedTemplate: null, instructionsChanged: false }
    http.get.mockResolvedValueOnce(ok2xx(view))
    const result = await grp.latestRun('r1')
    expect(result.success).toBe(true)
    expect((result as any).data.kind).toBe('applied')
  })

  it('latestRun 4xx → {success:false}', async () => {
    http.get.mockResolvedValueOnce(err4xx(404, 'Not Found'))
    const result = await grp.latestRun('x')
    expect(result.success).toBe(false)
  })

  // RESULT: previewSelection
  it('previewSelection 2xx → {success:true, data: PreviewSelectionResult}', async () => {
    const preview = { kind: 'selected', templateId: 't1', confidence: 0.85, reason: 'Match', elapsedMs: 120 }
    http.get.mockResolvedValueOnce(ok2xx(preview))
    const result = await grp.previewSelection('r1')
    expect(result.success).toBe(true)
    expect((result as any).data.kind).toBe('selected')
  })

  // RESULT: acceptSuggestedTemplate
  it('acceptSuggestedTemplate 2xx → {success:true, data: SummarizationTemplate}', async () => {
    http.post.mockResolvedValueOnce(ok2xx(mockTemplate))
    const result = await grp.acceptSuggestedTemplate('r1')
    expect(result.success).toBe(true)
    expect((result as any).data.id).toBe('t1')
  })

  it('acceptSuggestedTemplate 4xx → {success:false}', async () => {
    http.post.mockResolvedValueOnce(err4xx(400, 'Error'))
    const result = await grp.acceptSuggestedTemplate('x')
    expect(result.success).toBe(false)
  })

  // INLINE: resummarizeWithTemplate
  it('resummarizeWithTemplate 2xx → {success:true}', async () => {
    http.post.mockResolvedValueOnce(ok2xx(null))
    const result = await grp.resummarizeWithTemplate('r1', 't1')
    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('resummarizeWithTemplate 4xx → {success:false, error: string}', async () => {
    http.post.mockResolvedValueOnce(err4xx(400, 'Error'))
    const result = await grp.resummarizeWithTemplate('r1', null)
    expect(result.success).toBe(false)
    expect(typeof result.error).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// quality (all RAW-THROW, no renderer call sites)
// ---------------------------------------------------------------------------

describe('makeQualityGroup', () => {
  let http: ReturnType<typeof makeHttp>
  let grp: ReturnType<typeof makeQualityGroup>

  beforeEach(() => {
    http = makeHttp()
    grp = makeQualityGroup({ http })
  })

  it('get 2xx → bare any', async () => {
    http.get.mockResolvedValueOnce(ok2xx({ quality: 'high', reason: 'clear audio' }))
    const result = await grp.get('r1')
    expect(result.quality).toBe('high')
  })

  it('get 4xx → throws', async () => {
    http.get.mockResolvedValueOnce(err4xx(404, 'Not Found'))
    await expect(grp.get('x')).rejects.toThrow('Not Found')
  })

  it('set 2xx → bare any', async () => {
    http.put.mockResolvedValueOnce(ok2xx({ quality: 'medium' }))
    const result = await grp.set('r1', 'medium')
    expect(result.quality).toBe('medium')
  })

  it('set 4xx → throws', async () => {
    http.put.mockResolvedValueOnce(err4xx(400, 'Bad'))
    await expect(grp.set('r1', 'low')).rejects.toThrow('Bad')
  })

  it('autoAssess 2xx → bare any', async () => {
    http.post.mockResolvedValueOnce(ok2xx({ quality: 'low', confidence: 0.7 }))
    const result = await grp.autoAssess('r1')
    expect(result.quality).toBe('low')
  })

  it('autoAssess 4xx → throws', async () => {
    http.post.mockResolvedValueOnce(err4xx(500, 'Error'))
    await expect(grp.autoAssess('r1')).rejects.toThrow('Error')
  })

  it('getByQuality 2xx → bare any', async () => {
    http.get.mockResolvedValueOnce(ok2xx({ items: [{ id: 'r1' }] }))
    const result = await grp.getByQuality('high')
    expect(result.items[0].id).toBe('r1')
  })

  it('getByQuality 4xx → throws', async () => {
    http.get.mockResolvedValueOnce(err4xx(500, 'Error'))
    await expect(grp.getByQuality('high')).rejects.toThrow('Error')
  })

  it('batchAutoAssess 2xx → bare any', async () => {
    http.post.mockResolvedValueOnce(ok2xx({ processed: 3 }))
    const result = await grp.batchAutoAssess(['r1', 'r2', 'r3'])
    expect(result.processed).toBe(3)
  })

  it('batchAutoAssess 4xx → throws', async () => {
    http.post.mockResolvedValueOnce(err4xx(500, 'Error'))
    await expect(grp.batchAutoAssess(['r1'])).rejects.toThrow('Error')
  })

  it('assessUnassessed 2xx → bare any', async () => {
    http.post.mockResolvedValueOnce(ok2xx({ assessed: 5 }))
    const result = await grp.assessUnassessed()
    expect(result.assessed).toBe(5)
  })

  it('assessUnassessed 4xx → throws', async () => {
    http.post.mockResolvedValueOnce(err4xx(500, 'Error'))
    await expect(grp.assessUnassessed()).rejects.toThrow('Error')
  })
})
