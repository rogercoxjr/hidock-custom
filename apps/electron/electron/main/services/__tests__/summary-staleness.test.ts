// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import os from 'os'
import fs from 'fs'

const shared = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _os = require('os') as typeof import('os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _fs = require('fs') as typeof import('fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _path = require('path') as typeof import('path')
  const tmpDir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'hidock-stale-'))
  const dataDir = _path.join(tmpDir, 'data')
  _fs.mkdirSync(dataDir, { recursive: true })
  return { tmpDir, dataDir, dbPath: _path.join(dataDir, 'hidock.db') }
})

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), getName: vi.fn(() => 'test') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() },
  Notification: { isSupported: vi.fn(() => false) }
}))
vi.mock('../file-storage', () => ({
  getDatabasePath: vi.fn(() => shared.dbPath),
  getRecordingsPath: vi.fn(() => shared.dataDir),
  getCachePath: vi.fn(() => os.tmpdir())
}))

import {
  initializeDatabase,
  closeDatabase,
  run,
  upsertTranscriptStage1,
  updateTranscriptStage2,
  isSummaryStale
} from '../database'

function insertRecording(id: string): void {
  run(
    `INSERT OR IGNORE INTO recordings
       (id, filename, file_path, date_recorded, status, transcription_status,
        location, on_device, on_local, created_at)
     VALUES (?, ?, ?, ?, 'complete', 'complete', 'local-only', 0, 1, ?)`,
    [id, `${id}.hda`, `/tmp/${id}.hda`, new Date().toISOString(), new Date().toISOString()]
  )
}
function seedStage1And2(id: string): void {
  upsertTranscriptStage1({
    recording_id: id,
    full_text: 'text',
    language: 'en',
    word_count: 1,
    transcription_provider: 'assemblyai',
    transcription_model: 'universal-3-pro'
  })
  updateTranscriptStage2(id, { summary: 'S', summarization_provider: 'ollama-cloud', summarization_model: 'm' })
}
/** Seed ONLY Stage 1 (full_text set, summarization_provider NULL) — Stage 2 not
 *  yet run / failed / parked. The row still has a created_at from its insert. */
function seedStage1Only(id: string): void {
  upsertTranscriptStage1({
    recording_id: id,
    full_text: 'text',
    language: 'en',
    word_count: 1,
    transcription_provider: 'assemblyai',
    transcription_model: 'universal-3-pro'
  })
}
/** Force a recording_speakers row's created_at to a fixed ISO instant. */
function mapSpeakerAt(id: string, label: string, createdAt: string): void {
  run(
    `INSERT INTO recording_speakers (recording_id, file_label, contact_id, source, created_at)
     VALUES (?, ?, NULL, 'user', ?)
     ON CONFLICT(recording_id, file_label) DO UPDATE SET created_at = excluded.created_at`,
    [id, label, createdAt]
  )
}
/** Force the transcript's summary stamp to a fixed instant (accepts ISO or space format). */
function stampSummaryAt(id: string, createdAt: string): void {
  run('UPDATE transcripts SET created_at = ? WHERE recording_id = ?', [createdAt, id])
}

describe('isSummaryStale (spec §6.6 / AC5)', () => {
  beforeEach(async () => {
    if (fs.existsSync(shared.dbPath)) fs.rmSync(shared.dbPath)
    await initializeDatabase()
  })
  afterEach(() => { try { closeDatabase() } catch { /* ignore */ } })

  it('false when no speakers are mapped (generic summary, nothing to attribute)', async () => {
    insertRecording('s1')
    seedStage1And2('s1')
    stampSummaryAt('s1', '2026-06-17T10:00:00.000Z')
    expect(isSummaryStale('s1')).toBe(false)
  })

  it('true when a mapping is NEWER than the summary stamp', async () => {
    insertRecording('s2')
    seedStage1And2('s2')
    stampSummaryAt('s2', '2026-06-17T10:00:00.000Z')
    mapSpeakerAt('s2', 'A', '2026-06-17T11:00:00.000Z') // mapped AFTER summarizing
    expect(isSummaryStale('s2')).toBe(true)
  })

  it('false when the summary stamp is NEWER than every mapping (re-summarized after mapping)', async () => {
    insertRecording('s3')
    seedStage1And2('s3')
    mapSpeakerAt('s3', 'A', '2026-06-17T10:00:00.000Z')
    stampSummaryAt('s3', '2026-06-17T12:00:00.000Z') // re-summarized after mapping
    expect(isSummaryStale('s3')).toBe(false)
  })

  it('false when there is no transcript row', async () => {
    expect(isSummaryStale('does-not-exist')).toBe(false)
  })

  // Mixed-format normalization test: recording_speakers.created_at is ISO
  // ('2026-06-17T11:00:00.000Z') while transcripts.created_at is space-format
  // ('2026-06-17 10:00:00'). A raw lexical '>' comparison fails here because
  // '2026-06-17T...' sorts AFTER '2026-06-17 ...' in ASCII (T > space), so
  // a stale=false case (mapping at 10:00, summary at 11:00) would WRONGLY
  // return true if the comparison is not normalized. This test proves datetime()
  // normalization in isSummaryStale fixes that.
  it('handles mixed ISO/space formats: space-format summary newer than ISO mapping → not stale', async () => {
    insertRecording('s5')
    seedStage1And2('s5')
    // mapping at 10:00 UTC (ISO format, as upsertRecordingSpeaker writes it)
    mapSpeakerAt('s5', 'A', '2026-06-17T10:00:00.000Z')
    // summary at 11:00 UTC stored in space format (as CURRENT_TIMESTAMP writes it)
    stampSummaryAt('s5', '2026-06-17 11:00:00')
    // Without datetime() normalization: 'T' > ' ' so ISO > space lexically even when
    // the actual time is earlier — a raw '>' would incorrectly report stale=true here.
    expect(isSummaryStale('s5')).toBe(false)
  })

  it('handles mixed ISO/space formats: ISO mapping newer than space-format summary → stale', async () => {
    insertRecording('s6')
    seedStage1And2('s6')
    // summary at 10:00 UTC in space format
    stampSummaryAt('s6', '2026-06-17 10:00:00')
    // mapping at 11:00 UTC in ISO format (as upsertRecordingSpeaker writes it)
    mapSpeakerAt('s6', 'A', '2026-06-17T11:00:00.000Z')
    // datetime() normalization must correctly identify that 11:00 > 10:00 → stale
    expect(isSummaryStale('s6')).toBe(true)
  })

  it('false when only Stage 1 exists (no summary): a newer mapping is NOT stale', async () => {
    insertRecording('s7')
    seedStage1Only('s7') // full_text set, summarization_provider NULL — no summary
    stampSummaryAt('s7', '2026-06-17T10:00:00.000Z') // row-insert stamp
    mapSpeakerAt('s7', 'A', '2026-06-17T11:00:00.000Z') // mapped AFTER the stamp
    // Mapping post-dates created_at, but there is no summary to be stale, so the
    // summarization_provider IS NOT NULL guard must keep this false.
    expect(isSummaryStale('s7')).toBe(false)
  })
})

afterAll(() => {
  try { fs.rmSync(shared.tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
})
