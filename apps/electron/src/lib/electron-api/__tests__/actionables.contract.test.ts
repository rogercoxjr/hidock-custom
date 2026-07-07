/**
 * actionables.contract.test.ts — Layer-2 SDK↔route contract tests for the actionables group.
 * See `contract-harness.ts` for the harness design.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeActionablesGroup } from '../groups/actionables'
import { http } from '../http'
import { makeContractApp, installFetchShim, closeContractApp, type ContractApp } from './contract-harness'

describe('actionables contract', () => {
  let ctx: ContractApp
  const grp = makeActionablesGroup({ http })
  const meetingId = 'meeting-actionables-1'
  const kcId = 'kc-actionables-1'

  async function seedActionable(id: string, status = 'pending'): Promise<void> {
    const { run } = await import('../../../../electron/main/services/database')
    run(
      `INSERT INTO actionables (id, type, title, source_knowledge_id, status) VALUES (?, ?, ?, ?, ?)`,
      [id, 'follow_up', 'Do the thing', kcId, status]
    )
  }

  beforeEach(async () => {
    ctx = await makeContractApp()
    installFetchShim(ctx.app, ctx.cookie)

    const { run, upsertMeeting } = await import('../../../../electron/main/services/database')
    upsertMeeting({
      id: meetingId,
      subject: 'Retro',
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
    run(`INSERT INTO knowledge_captures (id, title, captured_at, meeting_id) VALUES (?, ?, ?, ?)`, [
      kcId,
      'Retro notes',
      new Date().toISOString(),
      meetingId
    ])
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await closeContractApp(ctx)
  })

  it('getAll unwraps {items,total} into a bare array', async () => {
    await seedActionable('act-1')
    const result = await grp.getAll()
    expect(Array.isArray(result)).toBe(true)
    expect(result.some((a) => a.id === 'act-1')).toBe(true)
  })

  it('getByMeeting returns a bare array of actionables linked via the knowledge capture', async () => {
    await seedActionable('act-2')
    const result = await grp.getByMeeting(meetingId)
    expect(Array.isArray(result)).toBe(true)
    expect(result.some((a) => a.id === 'act-2')).toBe(true)
  })

  it('updateStatus returns an INLINE {success} envelope on a valid transition', async () => {
    await seedActionable('act-3', 'pending')
    const result = await grp.updateStatus('act-3', 'in_progress')
    expect(result.success).toBe(true)
  })

  it('generateOutput returns {success, data} from a pending actionable', async () => {
    await seedActionable('act-4', 'pending')
    const result = await grp.generateOutput('act-4')
    expect(result.success).toBe(true)
    expect(result.data?.actionableId).toBe('act-4')
  })
})
