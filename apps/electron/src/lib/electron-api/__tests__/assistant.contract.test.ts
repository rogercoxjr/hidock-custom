/**
 * assistant.contract.test.ts — Layer-2 SDK↔route contract tests for the assistant group.
 * See `contract-harness.ts` for the harness design.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeAssistantGroup } from '../groups/assistant'
import { http } from '../http'
import { makeContractApp, installFetchShim, closeContractApp, type ContractApp } from './contract-harness'

describe('assistant contract', () => {
  let ctx: ContractApp
  const grp = makeAssistantGroup({ http })
  let kcId: string

  beforeEach(async () => {
    ctx = await makeContractApp()
    installFetchShim(ctx.app, ctx.cookie)

    const { run } = await import('../../../../electron/main/services/database')
    kcId = 'kc-assistant-1'
    run(`INSERT INTO knowledge_captures (id, title, captured_at) VALUES (?, ?, ?)`, [
      kcId,
      'Pinned Capture',
      new Date().toISOString()
    ])
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await closeContractApp(ctx)
  })

  it('createConversation returns the bare Conversation object (RAW-THROW)', async () => {
    const conv = await grp.createConversation('My Conversation')
    expect(conv.id).toBeTruthy()
    expect(conv.title).toBe('My Conversation')
  })

  it('getConversations unwraps {items,total} into a bare array', async () => {
    await grp.createConversation('Conv A')
    const result = await grp.getConversations()
    expect(Array.isArray(result)).toBe(true)
    expect(result.some((c) => c.title === 'Conv A')).toBe(true)
  })

  it('getMessages returns [] for a fresh conversation, then the added message', async () => {
    const conv = await grp.createConversation()
    const empty = await grp.getMessages(conv.id)
    expect(empty).toEqual([])

    const msg = await grp.addMessage(conv.id, 'user', 'hello there')
    expect(msg.role).toBe('user')
    expect(msg.content).toBe('hello there')

    const after = await grp.getMessages(conv.id)
    expect(after).toHaveLength(1)
    expect(after[0].id).toBe(msg.id)
  })

  it('getContext / addContext / removeContext round-trip a knowledge capture id', async () => {
    const conv = await grp.createConversation()
    const empty = await grp.getContext(conv.id)
    expect(empty).toEqual([])

    const added = await grp.addContext(conv.id, kcId)
    expect(added.success).toBe(true)

    const withContext = await grp.getContext(conv.id)
    expect(withContext).toEqual([kcId])

    const removed = await grp.removeContext(conv.id, kcId)
    expect(removed.success).toBe(true)
    expect(await grp.getContext(conv.id)).toEqual([])
  })

  it('updateConversationTitle and deleteConversation return INLINE {success} envelopes', async () => {
    const conv = await grp.createConversation()
    const updated = await grp.updateConversationTitle(conv.id, 'Renamed')
    expect(updated.success).toBe(true)

    const deleted = await grp.deleteConversation(conv.id)
    expect(deleted.success).toBe(true)
  })
})
