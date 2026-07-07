/**
 * infra-voice.test.ts — Shape-assertion tests for the infra-voice SDK groups:
 *   storage, config, voiceprints, speakers, diarization, integrity,
 *   appInfo, deviceCache, storagePolicy, migration.
 *
 * Pattern: mock http; feed 2xx OR 4xx; assert EXACT returned shape per CONTRACTS.md.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeStorageGroup } from '../groups/storage'
import { makeConfigGroup } from '../groups/config'
import { makeVoiceprintsGroup } from '../groups/voiceprints'
import { makeSpeakersGroup } from '../groups/speakers'
import { makeDiarizationGroup } from '../groups/diarization'
import { makeIntegrityGroup } from '../groups/integrity'
import { makeAppInfoGroup } from '../groups/appInfo'
import { makeDeviceCacheGroup } from '../groups/deviceCache'
import { makeStoragePolicyGroup } from '../groups/storagePolicy'
import { makeMigrationGroup } from '../groups/migration'
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
    postForm: vi.fn(),
  } as unknown as Http & {
    get: ReturnType<typeof vi.fn>
    post: ReturnType<typeof vi.fn>
    patch: ReturnType<typeof vi.fn>
    put: ReturnType<typeof vi.fn>
    del: ReturnType<typeof vi.fn>
    postForm: ReturnType<typeof vi.fn>
  }
}

function ok2xx(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, data })
}

function err4xx(status = 400, error = 'Bad Request', data?: unknown) {
  return Promise.resolve({ ok: false, status, error, data })
}

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

describe('makeStorageGroup', () => {
  let http: ReturnType<typeof makeHttp>
  let grp: ReturnType<typeof makeStorageGroup>

  beforeEach(() => {
    http = makeHttp()
    grp = makeStorageGroup({ http })
  })

  // RAW-THROW: getInfo
  it('getInfo 2xx → bare any (result used at Settings.tsx)', async () => {
    http.get.mockResolvedValueOnce(ok2xx({ totalBytes: 1000, usedBytes: 500 }))
    const result = await grp.getInfo()
    expect(result.totalBytes).toBe(1000)
    expect(result.usedBytes).toBe(500)
  })

  it('getInfo 4xx → throws', async () => {
    http.get.mockResolvedValueOnce(err4xx(500, 'Server Error'))
    await expect(grp.getInfo()).rejects.toThrow('Server Error')
  })

  // DROPPED: openFolder → false
  it('openFolder → false (dropped)', async () => {
    const result = await grp.openFolder('recordings')
    expect(result).toBe(false)
  })

  // DROPPED: openFile → {success:false}
  it('openFile → {success:false} (dropped)', async () => {
    const result = await grp.openFile('/some/path.wav')
    expect(result.success).toBe(false)
    expect(typeof result.error).toBe('string')
  })

  // DROPPED: revealInFolder → {success:false}
  it('revealInFolder → {success:false} (dropped)', async () => {
    const result = await grp.revealInFolder('/some/path.wav')
    expect(result.success).toBe(false)
    expect(typeof result.error).toBe('string')
  })

  // DROPPED: readRecording → {success:false}
  it('readRecording → {success:false} (dropped)', async () => {
    const result = await grp.readRecording('/some/path.wav')
    expect(result.success).toBe(false)
    expect(typeof result.error).toBe('string')
  })

  // DROPPED: deleteRecording → false
  it('deleteRecording → false (dropped)', async () => {
    const result = await grp.deleteRecording('/some/path.wav')
    expect(result).toBe(false)
  })

  // DROPPED: saveRecording → '' (CONTRACTS: DROPPED resolves safe default, never throws)
  it('saveRecording → empty string (dropped)', async () => {
    const result = await grp.saveRecording('test.wav', [1, 2, 3])
    expect(typeof result).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

describe('makeConfigGroup', () => {
  let http: ReturnType<typeof makeHttp>
  let grp: ReturnType<typeof makeConfigGroup>

  beforeEach(() => {
    http = makeHttp()
    grp = makeConfigGroup({ http })
  })

  // RESULT: get → call site reads result.success / result.data / result.error?.message
  it('get 2xx → {success:true, data}', async () => {
    http.get.mockResolvedValueOnce(ok2xx({ theme: 'dark', apiKey: 'abc' }))
    const result = await grp.get()
    expect(result.success).toBe(true)
    expect((result as any).data.theme).toBe('dark')
  })

  it('get 4xx → {success:false, error:{message}}', async () => {
    http.get.mockResolvedValueOnce(err4xx(500, 'Config load failed'))
    const result = await grp.get()
    expect(result.success).toBe(false)
    expect(typeof (result as any).error?.message).toBe('string')
  })

  // RESULT: set
  it('set 2xx → {success:true, data}', async () => {
    http.patch.mockResolvedValueOnce(ok2xx({ theme: 'light' }))
    const result = await grp.set({ theme: 'light' })
    expect(result.success).toBe(true)
    expect((result as any).data.theme).toBe('light')
  })

  it('set 4xx → {success:false, error:{message}}', async () => {
    http.patch.mockResolvedValueOnce(err4xx(400, 'Bad config'))
    const result = await grp.set({})
    expect(result.success).toBe(false)
    expect(typeof (result as any).error?.message).toBe('string')
  })

  // RESULT: updateSection → call site reads result.success / result.error?.message
  it('updateSection 2xx → {success:true, data}', async () => {
    http.patch.mockResolvedValueOnce(ok2xx({ transcription: { provider: 'gemini' } }))
    const result = await grp.updateSection('transcription', { provider: 'gemini' })
    expect(result.success).toBe(true)
    expect((result as any).data).toBeDefined()
  })

  it('updateSection 4xx → {success:false, error:{message}}', async () => {
    http.patch.mockResolvedValueOnce(
      err4xx(422, 'Validation error', { details: { provider: 'Invalid' } }),
    )
    const result = await grp.updateSection('transcription', {})
    expect(result.success).toBe(false)
    const err = (result as any).error
    expect(typeof err?.message).toBe('string')
    expect(err?.details).toEqual({ provider: 'Invalid' })
  })

  // RAW-THROW: getValue
  it('getValue 2xx → bare value', async () => {
    http.get.mockResolvedValueOnce(ok2xx('dark'))
    const result = await grp.getValue('theme')
    expect(result).toBe('dark')
  })

  it('getValue 4xx → throws', async () => {
    http.get.mockResolvedValueOnce(err4xx(404, 'Key not found'))
    await expect(grp.getValue('missing')).rejects.toThrow('Key not found')
  })
})

// ---------------------------------------------------------------------------
// voiceprints
// ---------------------------------------------------------------------------

describe('makeVoiceprintsGroup', () => {
  let http: ReturnType<typeof makeHttp>
  let grp: ReturnType<typeof makeVoiceprintsGroup>

  beforeEach(() => {
    http = makeHttp()
    grp = makeVoiceprintsGroup({ http })
  })

  const mockVp = {
    id: 'vp1',
    contact_id: 'c1',
    recording_id: 'r1',
    file_label: 'SPEAKER_00',
    enabled: true,
    created_at: '2026-01-01T00:00:00Z',
  }

  // RESULT: listForContact
  it('listForContact 2xx → {success:true, data: VoiceprintSummary[]}', async () => {
    http.get.mockResolvedValueOnce(ok2xx([mockVp]))
    const result = await grp.listForContact('c1')
    expect(result.success).toBe(true)
    expect(Array.isArray((result as any).data)).toBe(true)
    expect((result as any).data[0].id).toBe('vp1')
  })

  it('listForContact 4xx → {success:false}', async () => {
    http.get.mockResolvedValueOnce(err4xx(404, 'Not Found'))
    const result = await grp.listForContact('x')
    expect(result.success).toBe(false)
  })

  // RESULT: disable
  it('disable 2xx → {success:true}', async () => {
    http.patch.mockResolvedValueOnce(ok2xx(null))
    const result = await grp.disable('vp1')
    expect(result.success).toBe(true)
  })

  it('disable 4xx → {success:false}', async () => {
    http.patch.mockResolvedValueOnce(err4xx(404, 'Not Found'))
    const result = await grp.disable('x')
    expect(result.success).toBe(false)
  })

  // RESULT: enable
  it('enable 2xx → {success:true}', async () => {
    http.patch.mockResolvedValueOnce(ok2xx(null))
    const result = await grp.enable('vp1')
    expect(result.success).toBe(true)
  })

  it('enable 4xx → {success:false}', async () => {
    http.patch.mockResolvedValueOnce(err4xx(400, 'Bad'))
    const result = await grp.enable('x')
    expect(result.success).toBe(false)
  })

  // RESULT: delete
  it('delete 2xx → {success:true}', async () => {
    http.del.mockResolvedValueOnce(ok2xx(null))
    const result = await grp.delete('vp1')
    expect(result.success).toBe(true)
  })

  it('delete 4xx → {success:false}', async () => {
    http.del.mockResolvedValueOnce(err4xx(404, 'Not Found'))
    const result = await grp.delete('x')
    expect(result.success).toBe(false)
  })

  // RESULT: clearAllForContact
  it('clearAllForContact 2xx → {success:true, data:{deleted}}', async () => {
    http.del.mockResolvedValueOnce(ok2xx({ deleted: 3 }))
    const result = await grp.clearAllForContact('c1')
    expect(result.success).toBe(true)
    expect((result as any).data.deleted).toBe(3)
  })

  it('clearAllForContact 4xx → {success:false}', async () => {
    http.del.mockResolvedValueOnce(err4xx(500, 'Error'))
    const result = await grp.clearAllForContact('c1')
    expect(result.success).toBe(false)
  })

  // RESULT: clearAll
  it('clearAll 2xx → {success:true, data:{deleted}}', async () => {
    http.del.mockResolvedValueOnce(ok2xx({ deleted: 7 }))
    const result = await grp.clearAll()
    expect(result.success).toBe(true)
    expect((result as any).data.deleted).toBe(7)
  })

  it('clearAll 4xx → {success:false}', async () => {
    http.del.mockResolvedValueOnce(err4xx(500, 'Error'))
    const result = await grp.clearAll()
    expect(result.success).toBe(false)
  })

  // RESULT: findBySource
  it('findBySource 2xx → {success:true, data: VoiceprintSummary[]}', async () => {
    http.get.mockResolvedValueOnce(ok2xx([mockVp]))
    const result = await grp.findBySource('r1', 'SPEAKER_00')
    expect(result.success).toBe(true)
    expect(Array.isArray((result as any).data)).toBe(true)
  })

  it('findBySource 4xx → {success:false}', async () => {
    http.get.mockResolvedValueOnce(err4xx(400, 'Bad'))
    const result = await grp.findBySource('r1', 'SPEAKER_00')
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// speakers
// ---------------------------------------------------------------------------

describe('makeSpeakersGroup', () => {
  let http: ReturnType<typeof makeHttp>
  let grp: ReturnType<typeof makeSpeakersGroup>

  beforeEach(() => {
    http = makeHttp()
    grp = makeSpeakersGroup({ http })
  })

  // RESULT: assign
  it('assign 2xx → {success:true}', async () => {
    http.put.mockResolvedValueOnce(
      ok2xx({ recordingId: 'r1', fileLabel: 'SPEAKER_00', contactId: 'c1' }),
    )
    const result = await grp.assign({ recordingId: 'r1', fileLabel: 'SPEAKER_00', contactId: 'c1' })
    expect(result.success).toBe(true)
  })

  it('assign 4xx → {success:false, error:{message}}', async () => {
    http.put.mockResolvedValueOnce(err4xx(400, 'Bad'))
    const result = await grp.assign({ recordingId: 'r1', fileLabel: 'SPEAKER_00', contactId: 'c1' })
    expect(result.success).toBe(false)
    expect(typeof (result as any).error?.message).toBe('string')
  })

  // RESULT: merge
  it('merge 2xx → {success:true}', async () => {
    http.post.mockResolvedValueOnce(
      ok2xx({ recordingId: 'r1', fromLabel: 'SPEAKER_00', toLabel: 'SPEAKER_01' }),
    )
    const result = await grp.merge({
      recordingId: 'r1',
      fromLabel: 'SPEAKER_00',
      toLabel: 'SPEAKER_01',
    })
    expect(result.success).toBe(true)
  })

  it('merge 4xx → {success:false, error:{message}}', async () => {
    http.post.mockResolvedValueOnce(err4xx(400, 'Bad'))
    const result = await grp.merge({
      recordingId: 'r1',
      fromLabel: 'SPEAKER_00',
      toLabel: 'SPEAKER_01',
    })
    expect(result.success).toBe(false)
    expect(typeof (result as any).error?.message).toBe('string')
  })

  // RESULT: unassign
  it('unassign 2xx → {success:true}', async () => {
    http.del.mockResolvedValueOnce(ok2xx(null))
    const result = await grp.unassign({ recordingId: 'r1', fileLabel: 'SPEAKER_00' })
    expect(result.success).toBe(true)
  })

  it('unassign 4xx → {success:false, error:{message}}', async () => {
    http.del.mockResolvedValueOnce(err4xx(404, 'Not Found'))
    const result = await grp.unassign({ recordingId: 'r1', fileLabel: 'SPEAKER_00' })
    expect(result.success).toBe(false)
    expect(typeof (result as any).error?.message).toBe('string')
  })

  // RESULT: getForRecording
  it('getForRecording 2xx → {success:true, data: Record}', async () => {
    const data = {
      SPEAKER_00: { contactId: 'c1', contactName: 'Alice' },
    }
    http.get.mockResolvedValueOnce(ok2xx(data))
    const result = await grp.getForRecording('r1')
    expect(result.success).toBe(true)
    expect((result as any).data['SPEAKER_00'].contactId).toBe('c1')
  })

  it('getForRecording 4xx → {success:false, error:{message}}', async () => {
    http.get.mockResolvedValueOnce(err4xx(404, 'Not Found'))
    const result = await grp.getForRecording('x')
    expect(result.success).toBe(false)
    expect(typeof (result as any).error?.message).toBe('string')
  })

  // RESULT: getSuggestions
  it('getSuggestions 2xx → {success:true, data: SuggestionView[]}', async () => {
    const sug = {
      id: 's1',
      kind: 'identity',
      targetLabel: 'SPEAKER_00',
      score: 0.9,
      rank: 1,
      rationale: null,
      requiresWarning: false,
    }
    http.get.mockResolvedValueOnce(ok2xx([sug]))
    const result = await grp.getSuggestions('r1')
    expect(result.success).toBe(true)
    expect(Array.isArray((result as any).data)).toBe(true)
    expect((result as any).data[0].id).toBe('s1')
  })

  it('getSuggestions 4xx → {success:false, error:{message}}', async () => {
    http.get.mockResolvedValueOnce(err4xx(500, 'Error'))
    const result = await grp.getSuggestions('r1')
    expect(result.success).toBe(false)
    expect(typeof (result as any).error?.message).toBe('string')
  })

  // RESULT: reassignTurns — reads res?.error?.message (error obj synthesis)
  it('reassignTurns 2xx → {success:true, data}', async () => {
    http.post.mockResolvedValueOnce(
      ok2xx({ recordingId: 'r1', targetLabel: 'SPEAKER_01', rewrittenCount: 5 }),
    )
    const result = await grp.reassignTurns({
      recordingId: 'r1',
      sourceLabel: 'SPEAKER_00',
      anchorIndex: 0,
      anchorStartMs: 1000,
      scope: 'after',
      target: { kind: 'existingLabel', label: 'SPEAKER_01' },
    })
    expect(result.success).toBe(true)
    expect((result as any).data.rewrittenCount).toBe(5)
  })

  it('reassignTurns 4xx → {success:false, error:{message}}', async () => {
    http.post.mockResolvedValueOnce(
      err4xx(422, 'Turn reassign failed', { details: { scope: 'Invalid scope' } }),
    )
    const result = await grp.reassignTurns({
      recordingId: 'r1',
      sourceLabel: 'SPEAKER_00',
      anchorIndex: 0,
      anchorStartMs: 0,
      scope: 'one',
      target: { kind: 'newSpeaker' },
    })
    expect(result.success).toBe(false)
    // Call site reads res?.error?.message
    expect(typeof (result as any).error?.message).toBe('string')
    expect((result as any).error.details).toEqual({ scope: 'Invalid scope' })
  })

  // RESULT: dismissSuggestion
  it('dismissSuggestion 2xx → {success:true, data:{id}}', async () => {
    http.post.mockResolvedValueOnce(ok2xx({ id: 's1' }))
    const result = await grp.dismissSuggestion('s1')
    expect(result.success).toBe(true)
    expect((result as any).data.id).toBe('s1')
  })

  it('dismissSuggestion 4xx → {success:false, error:{message}}', async () => {
    http.post.mockResolvedValueOnce(err4xx(404, 'Not Found'))
    const result = await grp.dismissSuggestion('x')
    expect(result.success).toBe(false)
    expect(typeof (result as any).error?.message).toBe('string')
  })

  // RESULT: acceptSuggestion
  it('acceptSuggestion 2xx → {success:true, data:{id}}', async () => {
    http.post.mockResolvedValueOnce(ok2xx({ id: 's1' }))
    const result = await grp.acceptSuggestion('s1')
    expect(result.success).toBe(true)
    expect((result as any).data.id).toBe('s1')
  })

  it('acceptSuggestion 4xx → {success:false, error:{message}}', async () => {
    http.post.mockResolvedValueOnce(err4xx(400, 'Bad'))
    const result = await grp.acceptSuggestion('x')
    expect(result.success).toBe(false)
    expect(typeof (result as any).error?.message).toBe('string')
  })

  // RESULT: setSelf
  it('setSelf 2xx → {success:true, data:{selfAssigned,...}}', async () => {
    http.post.mockResolvedValueOnce(
      ok2xx({ selfAssigned: true, contactId: 'c1' }),
    )
    const result = await grp.setSelf({ recordingId: 'r1', fileLabel: 'SPEAKER_00' })
    expect(result.success).toBe(true)
    expect((result as any).data.selfAssigned).toBe(true)
  })

  it('setSelf 4xx → {success:false, error:{message}}', async () => {
    http.post.mockResolvedValueOnce(err4xx(400, 'Bad'))
    const result = await grp.setSelf({ recordingId: 'r1', fileLabel: 'SPEAKER_00' })
    expect(result.success).toBe(false)
    expect(typeof (result as any).error?.message).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// diarization
// ---------------------------------------------------------------------------

describe('makeDiarizationGroup', () => {
  let http: ReturnType<typeof makeHttp>
  let grp: ReturnType<typeof makeDiarizationGroup>

  beforeEach(() => {
    http = makeHttp()
    grp = makeDiarizationGroup({ http })
  })

  const mockRun = {
    id: 'd1',
    recording_id: 'r1',
    provider: 'pyannote',
    label_count: 2,
    is_solo: 0,
    created_at: '2026-01-01T00:00:00Z',
  }

  // RESULT: getLatestRun (no renderer call site — type-shape test)
  it('getLatestRun 2xx → {success:true, data: DiarizationRun|null}', async () => {
    http.get.mockResolvedValueOnce(ok2xx(mockRun))
    const result = await grp.getLatestRun('r1')
    expect(result.success).toBe(true)
    expect((result as any).data.id).toBe('d1')
  })

  it('getLatestRun 2xx null → {success:true, data: null}', async () => {
    http.get.mockResolvedValueOnce(ok2xx(null))
    const result = await grp.getLatestRun('r1')
    expect(result.success).toBe(true)
    expect((result as any).data).toBeNull()
  })

  it('getLatestRun 4xx → {success:false}', async () => {
    http.get.mockResolvedValueOnce(err4xx(404, 'Not Found'))
    const result = await grp.getLatestRun('x')
    expect(result.success).toBe(false)
  })

  // RESULT: getRunsForRecording (no renderer call site — type-shape test)
  it('getRunsForRecording 2xx → {success:true, data: DiarizationRun[]}', async () => {
    http.get.mockResolvedValueOnce(ok2xx([mockRun]))
    const result = await grp.getRunsForRecording('r1')
    expect(result.success).toBe(true)
    expect(Array.isArray((result as any).data)).toBe(true)
    expect((result as any).data[0].provider).toBe('pyannote')
  })

  it('getRunsForRecording 4xx → {success:false}', async () => {
    http.get.mockResolvedValueOnce(err4xx(500, 'Error'))
    const result = await grp.getRunsForRecording('r1')
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// integrity
// ---------------------------------------------------------------------------

describe('makeIntegrityGroup', () => {
  let http: ReturnType<typeof makeHttp>
  let grp: ReturnType<typeof makeIntegrityGroup>

  beforeEach(() => {
    http = makeHttp()
    grp = makeIntegrityGroup({ http })
  })

  const mockScanReport = {
    scanStarted: '2026-01-01T00:00:00Z',
    scanCompleted: '2026-01-01T00:00:01Z',
    totalIssues: 1,
    issuesByType: { orphaned: 1 },
    issuesBySeverity: { medium: 1 },
    issues: [
      {
        id: 'i1',
        type: 'orphaned_transcript',
        severity: 'medium' as const,
        description: 'Transcript has no recording',
        suggestedAction: 'delete',
        autoRepairable: true,
      },
    ],
    autoRepairableCount: 1,
  }

  // RAW-THROW: runScan
  it('runScan 2xx → bare scan report', async () => {
    http.post.mockResolvedValueOnce(ok2xx(mockScanReport))
    const result = await grp.runScan()
    expect(result.totalIssues).toBe(1)
    expect(Array.isArray(result.issues)).toBe(true)
    expect(result.issues[0].id).toBe('i1')
  })

  it('runScan 4xx → throws', async () => {
    http.post.mockResolvedValueOnce(err4xx(500, 'Scan failed'))
    await expect(grp.runScan()).rejects.toThrow('Scan failed')
  })

  // RAW-THROW: getReport
  it('getReport 2xx → bare any', async () => {
    http.get.mockResolvedValueOnce(ok2xx({ lastScan: '2026-01-01T00:00:00Z' }))
    const result = await grp.getReport()
    expect(result.lastScan).toBe('2026-01-01T00:00:00Z')
  })

  it('getReport 4xx → throws', async () => {
    http.get.mockResolvedValueOnce(err4xx(404, 'No report'))
    await expect(grp.getReport()).rejects.toThrow('No report')
  })

  // INLINE: repairIssue — no renderer call site; type-shape test
  it('repairIssue 2xx → {issueId, success:true, action}', async () => {
    http.post.mockResolvedValueOnce(ok2xx({ issueId: 'i1', success: true, action: 'deleted' }))
    const result = await grp.repairIssue('i1')
    expect(result.success).toBe(true)
    expect(result.issueId).toBe('i1')
    expect(typeof result.action).toBe('string')
    expect(result.error).toBeUndefined()
  })

  it('repairIssue 4xx → {issueId, success:false, action, error}', async () => {
    http.post.mockResolvedValueOnce(err4xx(500, 'Repair failed'))
    const result = await grp.repairIssue('i1')
    expect(result.success).toBe(false)
    expect(result.issueId).toBe('i1')
    expect(typeof result.error).toBe('string')
  })

  // INLINE-array: repairAll — call site reads setRepairResults(results)
  it('repairAll 2xx → Array<{issueId, success, action}>', async () => {
    http.post.mockResolvedValueOnce(
      ok2xx([{ issueId: 'i1', success: true, action: 'deleted' }]),
    )
    const result = await grp.repairAll()
    expect(Array.isArray(result)).toBe(true)
    expect(result[0].success).toBe(true)
    expect(result[0].issueId).toBe('i1')
  })

  it('repairAll 4xx → single-entry failure array', async () => {
    http.post.mockResolvedValueOnce(err4xx(500, 'All repairs failed'))
    const result = await grp.repairAll()
    expect(Array.isArray(result)).toBe(true)
    expect(result[0].success).toBe(false)
    expect(typeof result[0].error).toBe('string')
  })

  // RAW-THROW: runStartupChecks
  it('runStartupChecks 2xx → {issuesFound, issuesFixed}', async () => {
    http.post.mockResolvedValueOnce(ok2xx({ issuesFound: 2, issuesFixed: 1 }))
    const result = await grp.runStartupChecks()
    expect(result.issuesFound).toBe(2)
    expect(result.issuesFixed).toBe(1)
  })

  it('runStartupChecks 4xx → throws', async () => {
    http.post.mockResolvedValueOnce(err4xx(500, 'Error'))
    await expect(grp.runStartupChecks()).rejects.toThrow('Error')
  })

  // RAW-THROW: cleanupWronglyNamed
  it('cleanupWronglyNamed 2xx → {deletedFiles, keptFiles, clearedDbRecords}', async () => {
    http.post.mockResolvedValueOnce(
      ok2xx({ deletedFiles: ['a.wav'], keptFiles: ['b.wav'], clearedDbRecords: 1 }),
    )
    const result = await grp.cleanupWronglyNamed()
    expect(Array.isArray(result.deletedFiles)).toBe(true)
    expect(result.deletedFiles[0]).toBe('a.wav')
    expect(result.clearedDbRecords).toBe(1)
  })

  it('cleanupWronglyNamed 4xx → throws', async () => {
    http.post.mockResolvedValueOnce(err4xx(500, 'Cleanup failed'))
    await expect(grp.cleanupWronglyNamed()).rejects.toThrow('Cleanup failed')
  })

  // RAW-THROW: purgeMissingFiles
  it('purgeMissingFiles 2xx → {totalRecords, deleted, kept, deletedFiles}', async () => {
    http.post.mockResolvedValueOnce(
      ok2xx({ totalRecords: 10, deleted: 3, kept: 7, deletedFiles: ['a.wav'] }),
    )
    const result = await grp.purgeMissingFiles()
    expect(result.totalRecords).toBe(10)
    expect(result.deleted).toBe(3)
    expect(Array.isArray(result.deletedFiles)).toBe(true)
  })

  it('purgeMissingFiles 4xx → throws', async () => {
    http.post.mockResolvedValueOnce(err4xx(500, 'Purge failed'))
    await expect(grp.purgeMissingFiles()).rejects.toThrow('Purge failed')
  })
})

// ---------------------------------------------------------------------------
// appInfo
// ---------------------------------------------------------------------------

describe('makeAppInfoGroup', () => {
  let http: ReturnType<typeof makeHttp>
  let grp: ReturnType<typeof makeAppInfoGroup>

  beforeEach(() => {
    http = makeHttp()
    grp = makeAppInfoGroup({ http })
  })

  // RAW-THROW: info
  it('info 2xx → bare {version, name, isPackaged, platform}', async () => {
    http.get.mockResolvedValueOnce(
      ok2xx({ version: '1.0.0', name: 'HiDock', isPackaged: false, platform: 'win32' }),
    )
    const result = await grp.info()
    expect(result.version).toBe('1.0.0')
    expect(result.name).toBe('HiDock')
    expect(typeof result.isPackaged).toBe('boolean')
    expect(typeof result.platform).toBe('string')
  })

  it('info 4xx → throws', async () => {
    http.get.mockResolvedValueOnce(err4xx(500, 'Server Error'))
    await expect(grp.info()).rejects.toThrow('Server Error')
  })

  // DROPPED: restart → resolves void (no-op)
  it('restart → resolves void (no-op, dropped)', async () => {
    const result = await grp.restart()
    expect(result).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// deviceCache
// ---------------------------------------------------------------------------

describe('makeDeviceCacheGroup', () => {
  let http: ReturnType<typeof makeHttp>
  let grp: ReturnType<typeof makeDeviceCacheGroup>

  beforeEach(() => {
    http = makeHttp()
    grp = makeDeviceCacheGroup({ http })
  })

  // RAW-THROW: getAll
  it('getAll 2xx → bare any[]', async () => {
    http.get.mockResolvedValueOnce(ok2xx([{ filename: 'test.wav', size: 1000 }]))
    const result = await grp.getAll()
    expect(Array.isArray(result)).toBe(true)
    expect(result[0].filename).toBe('test.wav')
  })

  it('getAll 4xx → throws', async () => {
    http.get.mockResolvedValueOnce(err4xx(500, 'Server Error'))
    await expect(grp.getAll()).rejects.toThrow('Server Error')
  })

  // VOID: saveAll
  it('saveAll 2xx → resolves void', async () => {
    http.put.mockResolvedValueOnce(ok2xx(null))
    const result = await grp.saveAll([{ filename: 'test.wav' }])
    expect(result).toBeUndefined()
  })

  // Route PUT /api/device-cache expects `{ files: [...] }`, not a bare array.
  it('saveAll sends PUT body as `{ files: [...] }` (route contract)', async () => {
    http.put.mockResolvedValueOnce(ok2xx({ ok: true, count: 1 }))
    const files = [{ filename: 'test.wav' }]
    await grp.saveAll(files)
    expect(http.put).toHaveBeenCalledWith('/api/device-cache', { files })
  })

  it('saveAll 4xx → resolves void silently (VOID must not throw)', async () => {
    // CONTRACTS: VOID methods must never throw; failed PUT logs a warning and returns.
    http.put.mockResolvedValueOnce(err4xx(500, 'Error'))
    const result = await grp.saveAll([])
    expect(result).toBeUndefined()
  })

  // VOID: clear
  it('clear 2xx → resolves void', async () => {
    http.del.mockResolvedValueOnce(ok2xx(null))
    const result = await grp.clear()
    expect(result).toBeUndefined()
  })

  it('clear 4xx → resolves void silently (VOID must not throw)', async () => {
    // CONTRACTS: VOID methods must never throw; failed DELETE logs a warning and returns.
    http.del.mockResolvedValueOnce(err4xx(500, 'Error'))
    const result = await grp.clear()
    expect(result).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// storagePolicy (all RAW-THROW, no renderer call sites)
// ---------------------------------------------------------------------------

describe('makeStoragePolicyGroup', () => {
  let http: ReturnType<typeof makeHttp>
  let grp: ReturnType<typeof makeStoragePolicyGroup>

  beforeEach(() => {
    http = makeHttp()
    grp = makeStoragePolicyGroup({ http })
  })

  it('getByTier 2xx → bare any', async () => {
    http.get.mockResolvedValueOnce(ok2xx({ tier: 'hot', count: 10 }))
    const result = await grp.getByTier('hot')
    expect(result.tier).toBe('hot')
  })

  it('getByTier 4xx → throws', async () => {
    http.get.mockResolvedValueOnce(err4xx(500, 'Error'))
    await expect(grp.getByTier('hot')).rejects.toThrow('Error')
  })

  it('getCleanupSuggestions 2xx → bare any (uses GET per CONTRACTS)', async () => {
    http.get.mockResolvedValueOnce(ok2xx([{ recordingId: 'r1', tier: 'cold' }]))
    const result = await grp.getCleanupSuggestions()
    expect(Array.isArray(result)).toBe(true)
  })

  it('getCleanupSuggestions 4xx → throws', async () => {
    http.get.mockResolvedValueOnce(err4xx(500, 'Error'))
    await expect(grp.getCleanupSuggestions()).rejects.toThrow('Error')
  })

  it('getCleanupSuggestionsForTier 2xx → bare any', async () => {
    http.get.mockResolvedValueOnce(ok2xx([{ recordingId: 'r1' }]))
    const result = await grp.getCleanupSuggestionsForTier('warm')
    expect(Array.isArray(result)).toBe(true)
  })

  it('getCleanupSuggestionsForTier 4xx → throws', async () => {
    http.get.mockResolvedValueOnce(err4xx(500, 'Error'))
    await expect(grp.getCleanupSuggestionsForTier('warm')).rejects.toThrow('Error')
  })

  it('executeCleanup 2xx → bare any', async () => {
    http.post.mockResolvedValueOnce(ok2xx({ deleted: 2 }))
    const result = await grp.executeCleanup(['r1', 'r2'])
    expect(result.deleted).toBe(2)
  })

  // Route POST /api/storage-policy/execute-cleanup expects `{ ids }`, not `{ recordingIds, archive }`.
  it('executeCleanup sends POST body with `ids` key only (route contract)', async () => {
    http.post.mockResolvedValueOnce(ok2xx({ deleted: 2 }))
    await grp.executeCleanup(['r1', 'r2'])
    expect(http.post).toHaveBeenCalledWith('/api/storage-policy/execute-cleanup', { ids: ['r1', 'r2'] })
  })

  it('executeCleanup 4xx → throws', async () => {
    http.post.mockResolvedValueOnce(err4xx(500, 'Error'))
    await expect(grp.executeCleanup(['r1'])).rejects.toThrow('Error')
  })

  it('getStats 2xx → bare any', async () => {
    http.get.mockResolvedValueOnce(ok2xx({ hot: 5, warm: 3, cold: 1 }))
    const result = await grp.getStats()
    expect(result.hot).toBe(5)
  })

  it('getStats 4xx → throws', async () => {
    http.get.mockResolvedValueOnce(err4xx(500, 'Error'))
    await expect(grp.getStats()).rejects.toThrow('Error')
  })

  it('initializeUntiered 2xx → bare any', async () => {
    http.post.mockResolvedValueOnce(ok2xx({ initialized: 4 }))
    const result = await grp.initializeUntiered()
    expect(result.initialized).toBe(4)
  })

  it('initializeUntiered 4xx → throws', async () => {
    http.post.mockResolvedValueOnce(err4xx(500, 'Error'))
    await expect(grp.initializeUntiered()).rejects.toThrow('Error')
  })

  it('assignTier 2xx → bare any', async () => {
    http.post.mockResolvedValueOnce(ok2xx({ recordingId: 'r1', tier: 'hot' }))
    const result = await grp.assignTier('r1', 'high')
    expect(result.tier).toBe('hot')
  })

  it('assignTier 4xx → throws', async () => {
    http.post.mockResolvedValueOnce(err4xx(500, 'Error'))
    await expect(grp.assignTier('r1', 'high')).rejects.toThrow('Error')
  })
})

// ---------------------------------------------------------------------------
// migration (all RAW-THROW, no renderer call sites)
// ---------------------------------------------------------------------------

describe('makeMigrationGroup', () => {
  let http: ReturnType<typeof makeHttp>
  let grp: ReturnType<typeof makeMigrationGroup>

  beforeEach(() => {
    http = makeHttp()
    grp = makeMigrationGroup({ http })
  })

  // RAW-THROW: getStatus
  it('getStatus 2xx → bare MigrationStatus', async () => {
    http.get.mockResolvedValueOnce(ok2xx({ pending: 2, migrated: 10, skipped: 1, total: 13 }))
    const result = await grp.getStatus()
    expect(result.pending).toBe(2)
    expect(result.total).toBe(13)
  })

  it('getStatus 4xx → throws', async () => {
    http.get.mockResolvedValueOnce(err4xx(500, 'Error'))
    await expect(grp.getStatus()).rejects.toThrow('Error')
  })

  // RAW-THROW: previewCleanup
  it('previewCleanup 2xx → bare MigrationCleanupPreview', async () => {
    http.get.mockResolvedValueOnce(
      ok2xx({ orphanedTranscripts: [], duplicateRecordings: [], invalidMeetingRefs: [] }),
    )
    const result = await grp.previewCleanup()
    expect(Array.isArray(result.orphanedTranscripts)).toBe(true)
  })

  it('previewCleanup 4xx → throws', async () => {
    http.get.mockResolvedValueOnce(err4xx(500, 'Error'))
    await expect(grp.previewCleanup()).rejects.toThrow('Error')
  })

  // RAW-THROW: runCleanup (success is a data field, NOT a Result envelope)
  it('runCleanup 2xx → bare MigrationCleanupResult (success as data field)', async () => {
    http.post.mockResolvedValueOnce(
      ok2xx({
        success: true,
        orphanedTranscriptsRemoved: 2,
        duplicateRecordingsRemoved: 0,
        invalidMeetingRefsFixed: 0,
        errors: [],
      }),
    )
    const result = await grp.runCleanup()
    expect(result.success).toBe(true)
    expect(result.orphanedTranscriptsRemoved).toBe(2)
    expect(Array.isArray(result.errors)).toBe(true)
  })

  it('runCleanup 4xx → throws', async () => {
    http.post.mockResolvedValueOnce(err4xx(500, 'Error'))
    await expect(grp.runCleanup()).rejects.toThrow('Error')
  })

  // RAW-THROW: runV11
  it('runV11 2xx → bare MigrationResult', async () => {
    http.post.mockResolvedValueOnce(
      ok2xx({ success: true, capturesCreated: 5, errors: [] }),
    )
    const result = await grp.runV11()
    expect(result.success).toBe(true)
    expect(result.capturesCreated).toBe(5)
  })

  it('runV11 4xx → throws', async () => {
    http.post.mockResolvedValueOnce(err4xx(500, 'Error'))
    await expect(grp.runV11()).rejects.toThrow('Error')
  })

  // RAW-THROW: rollbackV11
  it('rollbackV11 2xx → bare MigrationRollbackResult', async () => {
    http.post.mockResolvedValueOnce(ok2xx({ success: true, errors: [] }))
    const result = await grp.rollbackV11()
    expect(result.success).toBe(true)
    expect(Array.isArray(result.errors)).toBe(true)
  })

  it('rollbackV11 4xx → throws', async () => {
    http.post.mockResolvedValueOnce(err4xx(500, 'Error'))
    await expect(grp.rollbackV11()).rejects.toThrow('Error')
  })
})
