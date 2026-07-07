/**
 * contacts.contract.test.ts — Layer-2 SDK↔route contract tests for the contacts group.
 * See `contract-harness.ts` for the harness design.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeContactsGroup } from '../groups/contacts'
import { http } from '../http'
import { makeContractApp, installFetchShim, closeContractApp, type ContractApp } from './contract-harness'

describe('contacts contract', () => {
  let ctx: ContractApp
  const grp = makeContactsGroup({ http })

  beforeEach(async () => {
    ctx = await makeContractApp()
    installFetchShim(ctx.app, ctx.cookie)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await closeContractApp(ctx)
  })

  it('create returns a RESULT envelope wrapping the created Person', async () => {
    const result = await grp.create({ name: 'Alice' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.name).toBe('Alice')
    }
  })

  it('getAll normalizes {items,total} into {contacts,total}', async () => {
    await grp.create({ name: 'Bob' })
    const result = await grp.getAll()
    expect(result.success).toBe(true)
    if (result.success) {
      expect(Array.isArray(result.data.contacts)).toBe(true)
      expect(result.data.contacts.some((c: { name: string }) => c.name === 'Bob')).toBe(true)
      expect(typeof result.data.total).toBe('number')
    }
  })

  it('getById returns {contact, meetings, totalMeetingTimeMinutes}', async () => {
    const created = await grp.create({ name: 'Carol' })
    expect(created.success).toBe(true)
    if (!created.success) return
    const result = await grp.getById(created.data.id)
    expect(result.success).toBe(true)
    if (result.success) {
      expect((result.data as unknown as { contact: { name: string } }).contact.name).toBe('Carol')
    }
  })

  it('update returns the updated Contact', async () => {
    const created = await grp.create({ name: 'Dave' })
    if (!created.success) throw new Error('setup failed')
    const result = await grp.update({ id: created.data.id, name: 'Dave Renamed' } as never)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.name).toBe('Dave Renamed')
  })

  it('getSelf / setSelf round-trip the self contact id', async () => {
    const created = await grp.create({ name: 'Self Person' })
    if (!created.success) throw new Error('setup failed')

    const before = await grp.getSelf()
    expect(before.success).toBe(true)
    if (before.success) expect(before.data).toBeNull()

    const set = await grp.setSelf({ contactId: created.data.id })
    expect(set.success).toBe(true)

    const after = await grp.getSelf()
    expect(after.success).toBe(true)
    if (after.success) expect(after.data?.id).toBe(created.data.id)
  })

  it('getForMeeting returns a bare Contact[] for an existing meeting', async () => {
    const { upsertMeeting } = await import('../../../../electron/main/services/database')
    upsertMeeting({
      id: 'meeting-contacts-1',
      subject: 'Sync',
      start_time: '2024-01-01T10:00:00Z',
      end_time: '2024-01-01T11:00:00Z',
      location: null,
      organizer_name: null,
      organizer_email: null,
      attendees: null,
      description: null,
      is_recurring: 0,
      recurrence_rule: null,
      meeting_url: null
    })
    const result = await grp.getForMeeting('meeting-contacts-1')
    expect(result.success).toBe(true)
    if (result.success) expect(Array.isArray(result.data)).toBe(true)
  })

  it('delete returns a RESULT envelope on success', async () => {
    const created = await grp.create({ name: 'ToDelete' })
    if (!created.success) throw new Error('setup failed')
    const result = await grp.delete(created.data.id)
    expect(result.success).toBe(true)
  })
})
