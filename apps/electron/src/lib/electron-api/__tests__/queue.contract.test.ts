/**
 * queue.contract.test.ts — Layer-2 SDK↔route contract tests for the queue group.
 *
 * Runs the REAL `makeQueueGroup({ http })` (real `http.ts` transport) against the REAL Fastify
 * app (see `contract-harness.ts`). Each test seeds minimal DB state via the same
 * `main/services/database` functions the server uses, then asserts the SDK call succeeds
 * (no 400/404/405, does not throw) and returns the unwrapped/typed shape the group's own type
 * signature promises.
 *
 * GROUP SURFACE: `queue` exposes a single method — `getItems(status?)` — a RAW-THROW GET that
 * maps to `GET /api/queue?status=` and returns a bare `any[]` (2xx) or throws (error). Both the
 * unfiltered and `?status=` variants are safe happy paths (list / filtered-list), so both are
 * covered here. An empty queue -> `[]` is a valid happy-path.
 *
 * NOTHING SKIPPED: the group has no methods that require live network / LLM / multipart /
 * streaming (the only method is a plain JSON GET), so unlike sibling groups (rag, calendar)
 * there is nothing to document as deliberately out-of-scope here. postForm/postStream are never
 * touched by this group.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeQueueGroup } from '../groups/queue'
import { http } from '../http'
import { makeContractApp, installFetchShim, closeContractApp, type ContractApp } from './contract-harness'

describe('queue contract', () => {
  let ctx: ContractApp
  const grp = makeQueueGroup({ http })

  beforeEach(async () => {
    ctx = await makeContractApp()
    installFetchShim(ctx.app, ctx.cookie)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await closeContractApp(ctx)
  })

  // Seeds a recording + a (pending, by schema default) queue item, returning the queue item id.
  async function seedQueueItem(recordingId: string): Promise<string> {
    const { insertRecording, addToQueue } = await import('../../../../electron/main/services/database')
    insertRecording({
      id: recordingId,
      filename: `${recordingId}.hda`,
      file_path: null,
      date_recorded: '2024-01-01T10:00:00Z',
      status: 'ready',
      location: 'device-only',
      transcription_status: 'pending',
      on_device: 1,
      on_local: 0,
      source: 'hidock',
      is_imported: 0
    })
    return addToQueue(recordingId)
  }

  it('getItems returns a bare array (RAW-THROW), [] on an empty queue', async () => {
    const result = await grp.getItems()
    // (a) did not throw / succeeded. (b) unwrapped shape: a bare array, NOT a {items,total} wrapper.
    expect(Array.isArray(result)).toBe(true)
    expect(result).toEqual([])
  })

  it('getItems returns the queued item as a bare array element (not {items,total})', async () => {
    const queueItemId = await seedQueueItem('rec-q-1')

    const result = await grp.getItems()
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBe(1)
    // Unwrapped/typed shape: the array element is the raw QueueItem row (joined with filename),
    // not a paginated wrapper object.
    const item = result[0]
    expect(item.id).toBe(queueItemId)
    expect(item.recording_id).toBe('rec-q-1')
    expect(item.status).toBe('pending')
    expect(item.filename).toBe('rec-q-1.hda')
  })

  it('getItems(status) forwards the ?status= filter and returns matching items', async () => {
    await seedQueueItem('rec-q-2')

    const result = await grp.getItems('pending')
    // (a) the status query param round-trips without a 400/404 (filter is a real query param).
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBe(1)
    expect(result[0].recording_id).toBe('rec-q-2')
    expect(result[0].status).toBe('pending')
  })

  it('getItems(status) with a non-matching status returns [] (valid happy-path, no error)', async () => {
    await seedQueueItem('rec-q-3')

    // Seeded item is 'pending'; filtering on 'completed' matches nothing but is still a 2xx.
    const result = await grp.getItems('completed')
    expect(Array.isArray(result)).toBe(true)
    expect(result).toEqual([])
  })
})
