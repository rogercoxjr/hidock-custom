/**
 * chat.contract.test.ts — Layer-2 SDK↔route contract tests for the `chat` group.
 * See `contract-harness.ts` for the harness design (boots the REAL Fastify app, logs in, and
 * shims global `fetch` onto `app.inject()` so the REAL `http.ts` transport hits real routes).
 *
 * Runs the REAL `makeChatGroup({ http })` against the REAL app, seeding `chat_messages` rows via
 * the same `main/services/database` helpers the routes use. Each test asserts the SDK call (a)
 * succeeds — no 400/404/405 / no throw — and (b) returns the unwrapped/typed shape the group's
 * own signature promises.
 *
 * SCOPE — the `chat` group (../groups/chat.ts) has exactly three methods, and ALL are safe,
 * no-network happy paths, so ALL are covered and NOTHING is skipped here:
 *
 *   getHistory   RAW-THROW  GET    /api/chat/history?limit=  → bare ChatMessage[]
 *   addMessage   RAW-THROW  POST   /api/chat/messages        → bare { id, role, content, sources }
 *   clearHistory BOOL       DELETE /api/chat/history          → boolean (mapped from r.ok)
 *
 * NOTHING SKIPPED for network/LLM/multipart/streaming reasons: this is the LEGACY chat-history
 * namespace — plain SQLite CRUD against `chat_messages`. It does NOT talk to any chat-LLM
 * provider (the provider round-trip lives in the `rag` group's chat()/summarizeMeeting(), which
 * `rag.contract.test.ts` skips for exactly that reason). No method here uses multipart or
 * streaming bodies. The two mutations carry `requireSameOrigin`, but a MISSING Origin header is
 * intentionally allowed (electron/server/auth.ts:35-40), and the harness fetch shim sends no
 * Origin, so both round-trip through in-process `app.inject()`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeChatGroup } from '../groups/chat'
import { http } from '../http'
import { makeContractApp, installFetchShim, closeContractApp, type ContractApp } from './contract-harness'

describe('chat contract', () => {
  let ctx: ContractApp
  const grp = makeChatGroup({ http })

  beforeEach(async () => {
    ctx = await makeContractApp()
    installFetchShim(ctx.app, ctx.cookie)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await closeContractApp(ctx)
  })

  it('getHistory returns a bare array (RAW-THROW), [] on an empty DB', async () => {
    const result = await grp.getHistory()
    expect(Array.isArray(result)).toBe(true)
    expect(result).toEqual([])
  })

  it('getHistory returns a bare array of typed ChatMessage rows, not {items,total}', async () => {
    const { addChatMessage } = await import('../../../../electron/main/services/database')
    addChatMessage('user', 'What is the weather?')
    addChatMessage('assistant', 'The answer is 42.', JSON.stringify([{ id: 'rec-1', title: 'Test' }]))

    const result = await grp.getHistory()
    expect(Array.isArray(result)).toBe(true)
    // Unwrapped shape: a bare array, NOT a paginated { items, total } envelope.
    expect((result as unknown as { items?: unknown }).items).toBeUndefined()
    expect(result.length).toBe(2)

    const roles = result.map((m) => m.role)
    expect(roles).toContain('user')
    expect(roles).toContain('assistant')
    const first = result[0]
    expect(typeof first.id).toBe('string')
    expect(typeof first.content).toBe('string')
    expect(typeof first.created_at).toBe('string')
  })

  it('addMessage returns the bare inserted row (RAW-THROW), not a Result/envelope', async () => {
    const result = await grp.addMessage('user', 'hello from the contract test')
    // Bare object — no {success,data} wrapper, no {ok} wrapper.
    expect(result.success).toBeUndefined()
    expect(typeof result.id).toBe('string')
    expect(result.role).toBe('user')
    expect(result.content).toBe('hello from the contract test')
    // Route echoes `sources ?? null` when none supplied.
    expect(result.sources).toBeNull()
  })

  it('addMessage round-trips the optional sources field', async () => {
    const sources = JSON.stringify([{ id: 'rec-9', title: 'Meeting notes' }])
    const result = await grp.addMessage('assistant', 'Here are your sources.', sources)
    expect(result.role).toBe('assistant')
    expect(result.sources).toBe(sources)
  })

  it('clearHistory returns a bare boolean true (BOOL) and empties the history', async () => {
    const { addChatMessage } = await import('../../../../electron/main/services/database')
    addChatMessage('user', 'will be cleared')

    const cleared = await grp.clearHistory()
    // BOOL group: raw boolean, not a Result envelope.
    expect(cleared).toBe(true)

    // Confirm the DELETE route actually emptied the table (not a false-positive 200).
    const after = await grp.getHistory()
    expect(after).toEqual([])
  })
})
