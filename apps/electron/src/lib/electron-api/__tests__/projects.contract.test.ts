/**
 * projects.contract.test.ts — Layer-2 SDK↔route contract tests for the projects group.
 * See `contract-harness.ts` for the harness design.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeProjectsGroup } from '../groups/projects'
import { http } from '../http'
import { makeContractApp, installFetchShim, closeContractApp, type ContractApp } from './contract-harness'

describe('projects contract', () => {
  let ctx: ContractApp
  const grp = makeProjectsGroup({ http })
  const meetingId = 'meeting-projects-1'

  beforeEach(async () => {
    ctx = await makeContractApp()
    installFetchShim(ctx.app, ctx.cookie)

    const { upsertMeeting } = await import('../../../../electron/main/services/database')
    upsertMeeting({
      id: meetingId,
      subject: 'Planning',
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
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await closeContractApp(ctx)
  })

  it('create returns a RESULT envelope wrapping the created Project', async () => {
    const result = await grp.create({ name: 'Project One' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.name).toBe('Project One')
  })

  it('getAll maps {items,total} into {projects,total}', async () => {
    await grp.create({ name: 'Project Two' })
    const result = await grp.getAll()
    expect(result.success).toBe(true)
    if (result.success) {
      expect(Array.isArray(result.data.projects)).toBe(true)
      expect(result.data.projects.some((p) => p.name === 'Project Two')).toBe(true)
      expect(typeof result.data.total).toBe('number')
    }
  })

  it('getById returns {project, meetings, topics}', async () => {
    const created = await grp.create({ name: 'Project Three' })
    if (!created.success) throw new Error('setup failed')
    const result = await grp.getById(created.data.id)
    expect(result.success).toBe(true)
    if (result.success) {
      expect((result.data as unknown as { project: { name: string } }).project.name).toBe('Project Three')
    }
  })

  it('update returns the updated Project', async () => {
    const created = await grp.create({ name: 'Project Four' })
    if (!created.success) throw new Error('setup failed')
    const result = await grp.update({ id: created.data.id, name: 'Project Four Renamed' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.name).toBe('Project Four Renamed')
  })

  it('tagMeeting / getForMeeting / untagMeeting round-trip the project↔meeting link', async () => {
    const created = await grp.create({ name: 'Project Five' })
    if (!created.success) throw new Error('setup failed')

    const tagged = await grp.tagMeeting({ meetingId, projectId: created.data.id })
    expect(tagged.success).toBe(true)

    const forMeeting = await grp.getForMeeting(meetingId)
    expect(forMeeting.success).toBe(true)
    if (forMeeting.success) {
      expect(Array.isArray(forMeeting.data)).toBe(true)
      expect(forMeeting.data.some((p) => p.id === created.data.id)).toBe(true)
    }

    const untagged = await grp.untagMeeting({ meetingId, projectId: created.data.id })
    expect(untagged.success).toBe(true)
  })

  it('delete returns a RESULT envelope on success', async () => {
    const created = await grp.create({ name: 'Project Six' })
    if (!created.success) throw new Error('setup failed')
    const result = await grp.delete(created.data.id)
    expect(result.success).toBe(true)
  })
})
