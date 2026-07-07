/**
 * meetings.contract.test.ts — Layer-2 SDK↔route contract tests for the meetings group.
 * See `contract-harness.ts` for the harness design.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeMeetingsGroup } from '../groups/meetings'
import { http } from '../http'
import { makeContractApp, installFetchShim, closeContractApp, type ContractApp } from './contract-harness'

describe('meetings contract', () => {
  let ctx: ContractApp
  const grp = makeMeetingsGroup({ http })
  const meetingId = 'meeting-1'

  beforeEach(async () => {
    ctx = await makeContractApp()
    installFetchShim(ctx.app, ctx.cookie)

    const { upsertMeeting } = await import('../../../../electron/main/services/database')
    upsertMeeting({
      id: meetingId,
      subject: 'Standup',
      start_time: '2024-01-01T10:00:00Z',
      end_time: '2024-01-01T10:15:00Z',
      location: null,
      organizer_name: null,
      organizer_email: null,
      attendees: null,
      description: null,
      is_recurring: 0,
      recurrence_rule: null,
      meeting_url: null
    })
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await closeContractApp(ctx)
  })

  it('getAll returns a bare array (RAW-THROW)', async () => {
    const result = await grp.getAll()
    expect(Array.isArray(result)).toBe(true)
    expect(result.some((m) => m.id === meetingId)).toBe(true)
  })

  it('getById returns the bare meeting object', async () => {
    const result = await grp.getById(meetingId)
    expect(result.id).toBe(meetingId)
    expect(result.subject).toBe('Standup')
  })

  it('getByIds returns a keyed object (Map serialized), not an array', async () => {
    const result = await grp.getByIds([meetingId, 'does-not-exist'])
    expect(Array.isArray(result)).toBe(false)
    expect(result[meetingId].subject).toBe('Standup')
    expect(result['does-not-exist']).toBeUndefined()
  })

  it('getDetails returns {meeting, recordings}', async () => {
    const result = await grp.getDetails(meetingId)
    expect(result.meeting.id).toBe(meetingId)
    expect(Array.isArray(result.recordings)).toBe(true)
  })

  it('update returns a RESULT envelope wrapping the updated meeting', async () => {
    const result = await grp.update({ id: meetingId, subject: 'Standup (renamed)' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.subject).toBe('Standup (renamed)')
  })
})
