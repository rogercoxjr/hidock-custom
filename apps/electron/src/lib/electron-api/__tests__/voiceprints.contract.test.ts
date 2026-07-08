/**
 * voiceprints.contract.test.ts — Layer-2 SDK↔route contract tests for the voiceprints group.
 * See `contract-harness.ts` for the harness design (boots the real Fastify app + real `http`
 * transport, logs in ADMIN_EMAIL, and shims `fetch` → `app.inject()`).
 *
 * SCOPE: every method of `makeVoiceprintsGroup` has a safe, DB-only happy path — none touch a
 * live network, LLM, multipart upload, or streaming body, so NOTHING here is skipped for those
 * reasons. All seven methods are covered:
 *   - listForContact  → GET  /api/contacts/:contactId/voiceprints  (bare array route)
 *   - findBySource    → GET  /api/voiceprints?recordingId=&fileLabel=&contactId=
 *   - disable/enable  → PATCH /api/voiceprints/:id { enabled }      ({ ok:true } route)
 *   - delete          → DELETE /api/voiceprints/:id                 ({ ok:true } route)
 *   - clearAllForContact → DELETE /api/voiceprints?contactId=       ({ deleted } route)
 *   - clearAll        → DELETE /api/voiceprints                     ({ deleted } route, admin-only)
 *
 * NOTE ON ENROLLMENT: the SDK group has NO create/enroll method — voiceprints are minted
 * server-side by the speaker-ID pipeline, not over this REST surface. So fixtures are seeded
 * directly via `insertVoiceprint` (mirroring electron/server/__tests__/voiceprints.test.ts),
 * exactly the way the sibling contract tests seed with the DB service functions.
 *
 * CONTRACT INVARIANTS asserted per method: (a) the happy path does NOT throw and returns
 * `success: true` (no 400/404/405 leaking through); (b) the unwrapped/typed shape matches the
 * group's declared return type — list/find return a bare `VoiceprintSummary[]` (an ARRAY, not
 * a `{ items, total }` envelope) with the embedding BLOB projected away; void mutations return
 * `data === undefined`; the clear-* methods return the bare `{ deleted: number }` object.
 * Admin-only clear paths pass because the harness logs in as the bootstrapped admin.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeVoiceprintsGroup } from '../groups/voiceprints'
import { http } from '../http'
import { makeContractApp, installFetchShim, closeContractApp, type ContractApp } from './contract-harness'

const CONTACT_ID = 'contact-vp-1'
const RECORDING_ID = 'recording-vp-1'
const VP_ID_1 = 'vp-1'
const VP_ID_2 = 'vp-2'

/**
 * Seeds a contact + recording + two voiceprints into the (freshly-booted) DB the app is using.
 * Mirrors electron/server/__tests__/voiceprints.test.ts. Must run AFTER `makeContractApp()` so
 * the `await import(...)` resolves the same module instance the app initialised (see harness:
 * `vi.resetModules()` happens inside `makeContractApp`, not here).
 */
async function seedVoiceprints(): Promise<void> {
  const { upsertContact, insertRecording, insertVoiceprint } = await import(
    '../../../../electron/main/services/database'
  )

  upsertContact({
    id: CONTACT_ID,
    name: 'Alice Tester',
    email: 'alice@example.com',
    type: 'unknown',
    role: null,
    company: null,
    notes: null,
    tags: null,
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    meeting_count: 0,
    is_self: 0
  })

  insertRecording({
    id: RECORDING_ID,
    filename: 'meeting.hda',
    file_path: null,
    date_recorded: '2025-01-01T10:00:00Z',
    status: 'ready',
    location: 'device-only',
    transcription_status: 'none',
    on_device: 1,
    on_local: 0,
    source: 'hidock',
    is_imported: 0
  })

  insertVoiceprint({
    id: VP_ID_1,
    contact_id: CONTACT_ID,
    model_id: 'resnet-test',
    dim: 4,
    embedding: Buffer.from([0x01, 0x02, 0x03, 0x04]),
    source_recording_id: RECORDING_ID,
    source_label: 'Speaker_01',
    clean_speech_ms: 8000,
    created_from: 'confirmed'
  } as never)
  insertVoiceprint({
    id: VP_ID_2,
    contact_id: CONTACT_ID,
    model_id: 'resnet-test',
    dim: 4,
    embedding: Buffer.from([0x05, 0x06, 0x07, 0x08]),
    source_recording_id: RECORDING_ID,
    source_label: 'Speaker_02',
    clean_speech_ms: 5000,
    created_from: 'manual'
  } as never)
}

describe('voiceprints contract', () => {
  let ctx: ContractApp
  const grp = makeVoiceprintsGroup({ http })

  beforeEach(async () => {
    ctx = await makeContractApp()
    installFetchShim(ctx.app, ctx.cookie)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await closeContractApp(ctx)
  })

  // ---------------------------------------------------------------------------
  // listForContact — GET /api/contacts/:contactId/voiceprints (bare array)
  // ---------------------------------------------------------------------------

  it('listForContact returns a RESULT wrapping a bare VoiceprintSummary[] (no embedding BLOB)', async () => {
    await seedVoiceprints()
    const result = await grp.listForContact(CONTACT_ID)
    expect(result.success).toBe(true)
    if (!result.success) return
    // (b) unwrapped shape: an ARRAY, not a { items, total } envelope
    expect(Array.isArray(result.data)).toBe(true)
    expect(result.data).not.toHaveProperty('items')
    expect(result.data).toHaveLength(2)
    const vp = result.data.find((v) => v.id === VP_ID_1)
    expect(vp?.contactId).toBe(CONTACT_ID)
    expect(vp?.sourceLabel).toBe('Speaker_01')
    // embedding BLOB must never round-trip through the projection
    expect(vp).not.toHaveProperty('embedding')
  })

  it('listForContact on an unknown contact succeeds with [] (empty-DB happy path)', async () => {
    const result = await grp.listForContact('no-such-contact')
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).toEqual([])
  })

  // ---------------------------------------------------------------------------
  // findBySource — GET /api/voiceprints?recordingId=&fileLabel=&contactId=
  // ---------------------------------------------------------------------------

  it('findBySource returns a bare VoiceprintSummary[] matching (recordingId, fileLabel)', async () => {
    await seedVoiceprints()
    const result = await grp.findBySource(RECORDING_ID, 'Speaker_01')
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(Array.isArray(result.data)).toBe(true)
    expect(result.data).toHaveLength(1)
    expect(result.data[0].id).toBe(VP_ID_1)
    expect(result.data[0]).not.toHaveProperty('embedding')
  })

  it('findBySource with an explicit contactId scope succeeds and filters to that contact', async () => {
    await seedVoiceprints()
    const result = await grp.findBySource(RECORDING_ID, 'Speaker_01', CONTACT_ID)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(Array.isArray(result.data)).toBe(true)
      expect(result.data.every((vp) => vp.contactId === CONTACT_ID)).toBe(true)
    }
  })

  it('findBySource with no matching provenance succeeds with [] (empty happy path)', async () => {
    await seedVoiceprints()
    const result = await grp.findBySource(RECORDING_ID, 'Speaker_99')
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).toEqual([])
  })

  // ---------------------------------------------------------------------------
  // disable / enable — PATCH /api/voiceprints/:id { enabled }
  // ---------------------------------------------------------------------------

  it('disable then enable round-trips a RESULT<void> (data === undefined) and persists', async () => {
    await seedVoiceprints()

    const disabled = await grp.disable(VP_ID_1)
    expect(disabled.success).toBe(true)
    if (disabled.success) expect(disabled.data).toBeUndefined()

    const afterDisable = await grp.listForContact(CONTACT_ID)
    if (!afterDisable.success) throw new Error('list failed after disable')
    expect(afterDisable.data.find((v) => v.id === VP_ID_1)?.disabledAt).toBeTruthy()

    const enabled = await grp.enable(VP_ID_1)
    expect(enabled.success).toBe(true)
    if (enabled.success) expect(enabled.data).toBeUndefined()

    const afterEnable = await grp.listForContact(CONTACT_ID)
    if (!afterEnable.success) throw new Error('list failed after enable')
    expect(afterEnable.data.find((v) => v.id === VP_ID_1)?.disabledAt).toBeFalsy()
  })

  // ---------------------------------------------------------------------------
  // delete — DELETE /api/voiceprints/:id
  // ---------------------------------------------------------------------------

  it('delete returns a RESULT<void> (data === undefined) and removes the row', async () => {
    await seedVoiceprints()

    const result = await grp.delete(VP_ID_1)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).toBeUndefined()

    const after = await grp.listForContact(CONTACT_ID)
    if (!after.success) throw new Error('list failed after delete')
    expect(after.data.find((v) => v.id === VP_ID_1)).toBeUndefined()
    expect(after.data).toHaveLength(1)
  })

  // ---------------------------------------------------------------------------
  // clearAllForContact — DELETE /api/voiceprints?contactId=  (admin-only route)
  // ---------------------------------------------------------------------------

  it('clearAllForContact returns the bare { deleted: number } and empties the contact', async () => {
    await seedVoiceprints()

    const result = await grp.clearAllForContact(CONTACT_ID)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(typeof result.data.deleted).toBe('number')
      expect(result.data.deleted).toBe(2)
    }

    const after = await grp.listForContact(CONTACT_ID)
    if (after.success) expect(after.data).toEqual([])
  })

  it('clearAllForContact on an unknown contact succeeds with { deleted: 0 } (no-op happy path)', async () => {
    const result = await grp.clearAllForContact('no-such-contact')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(typeof result.data.deleted).toBe('number')
      expect(result.data.deleted).toBe(0)
    }
  })

  // ---------------------------------------------------------------------------
  // clearAll — DELETE /api/voiceprints  (admin-only global panic button)
  // ---------------------------------------------------------------------------

  it('clearAll returns the bare { deleted: number } and empties all voiceprints', async () => {
    await seedVoiceprints()

    const result = await grp.clearAll()
    expect(result.success).toBe(true)
    if (result.success) {
      expect(typeof result.data.deleted).toBe('number')
      expect(result.data.deleted).toBeGreaterThanOrEqual(2)
    }

    const after = await grp.listForContact(CONTACT_ID)
    if (after.success) expect(after.data).toEqual([])
  })
})
