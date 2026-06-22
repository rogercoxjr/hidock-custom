/**
 * @vitest-environment node
 */

// NOTE: the transcript-export formatters (toCsv/toSrt/toJson) are intentionally NOT
// mocked here — a formatter regression must surface in this handler suite too. Only
// electron, fs, and the database module are mocked.
import { describe, it, expect, beforeEach, vi } from 'vitest'

// --- electron mock: capture ipcMain.handle registrations + drive the save dialog ---
const handlers = new Map<string, (...args: any[]) => any>()
const showSaveDialog = vi.fn()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: any[]) => any) => handlers.set(ch, fn) },
  dialog: { showSaveDialog: (...a: any[]) => showSaveDialog(...a) },
  BrowserWindow: { fromWebContents: () => ({}) }
}))

// --- fs mock ---
const writeFileSync = vi.fn()
vi.mock('fs', () => ({ writeFileSync: (...a: any[]) => writeFileSync(...a) }))

// --- database mock ---
const getTranscriptByRecordingId = vi.fn()
const getRecordingById = vi.fn()
const getRecordingSpeakers = vi.fn()
const getContactById = vi.fn()
vi.mock('../../services/database', () => ({
  getTranscriptByRecordingId: (...a: any[]) => getTranscriptByRecordingId(...a),
  getRecordingById: (...a: any[]) => getRecordingById(...a),
  getRecordingSpeakers: (...a: any[]) => getRecordingSpeakers(...a),
  getContactById: (...a: any[]) => getContactById(...a)
}))

import { registerTranscriptsExportHandlers } from '../transcripts-export-handlers'

const FAKE_EVENT = { sender: {} } as any

// Typed baselines: an override typo (e.g. `turn` for `turns`) fails at compile time.
const DEFAULT_TRANSCRIPT_ROW = {
  id: 't1',
  recording_id: 'rec1',
  full_text: 'Hello world',
  language: 'en',
  turns: JSON.stringify([
    { speaker: 'Speaker_0', startMs: 0, endMs: 1000, text: 'Hi' },
    { speaker: 'Speaker_1', startMs: 1000, endMs: 2000, text: 'Bye' }
  ]) as string | null,
  summary: 'sum' as string | null,
  action_items: JSON.stringify(['do x']) as string | null,
  topics: JSON.stringify(['t']) as string | null,
  key_points: JSON.stringify(['k']) as string | null,
  sentiment: 'POSITIVE' as string | null,
  title_suggestion: 'My Meeting' as string | null,
  transcription_provider: 'assemblyai' as string | null,
  transcription_model: 'best' as string | null
}

const DEFAULT_RECORDING_ROW = {
  id: 'rec1',
  filename: 'rec1.wav',
  original_filename: 'orig.wav' as string | null,
  file_path: '/x/rec1.wav',
  date_recorded: '2026-06-22T10:00:00.000Z',
  duration_seconds: 120 as number | null,
  status: 'complete'
}

function setupTranscript(
  over: Partial<typeof DEFAULT_TRANSCRIPT_ROW> = {},
  recOver: Partial<typeof DEFAULT_RECORDING_ROW> = {}
) {
  getTranscriptByRecordingId.mockReturnValue({ ...DEFAULT_TRANSCRIPT_ROW, ...over })
  getRecordingById.mockReturnValue({ ...DEFAULT_RECORDING_ROW, ...recOver })
  getRecordingSpeakers.mockReturnValue([
    { recording_id: 'rec1', file_label: 'Speaker_0', contact_id: 'c1', confidence: null, source: 'user', created_at: 'x' }
  ])
  getContactById.mockReturnValue({ id: 'c1', name: 'Alice Johnson' })
}

beforeEach(() => {
  handlers.clear()
  showSaveDialog.mockReset()
  writeFileSync.mockReset()
  getTranscriptByRecordingId.mockReset()
  getRecordingById.mockReset()
  getRecordingSpeakers.mockReset()
  getContactById.mockReset()
  registerTranscriptsExportHandlers()
})

function callExport(args: { recordingId: string; format: 'csv' | 'srt' | 'json' }) {
  const fn = handlers.get('transcripts:export')!
  return fn(FAKE_EVENT, args)
}

describe('transcripts:export handler', () => {
  it('registers the channel', () => {
    expect(handlers.has('transcripts:export')).toBe(true)
  })

  it('returns NOT_FOUND and writes nothing when there is no transcript', async () => {
    getTranscriptByRecordingId.mockReturnValue(undefined)
    const res = await callExport({ recordingId: 'rec1', format: 'json' })
    expect(res.success).toBe(false)
    expect(res.error.code).toBe('NOT_FOUND')
    expect(writeFileSync).not.toHaveBeenCalled()
  })

  it('gates CSV on diarization with NOT_DIARIZED when turns are absent', async () => {
    setupTranscript({ turns: null })
    const res = await callExport({ recordingId: 'rec1', format: 'csv' })
    expect(res.success).toBe(false)
    expect(res.error.code).toBe('NOT_DIARIZED')
    expect(writeFileSync).not.toHaveBeenCalled()
  })

  it('gates SRT on diarization with NOT_DIARIZED when turns are absent', async () => {
    setupTranscript({ turns: null })
    const res = await callExport({ recordingId: 'rec1', format: 'srt' })
    expect(res.success).toBe(false)
    expect(res.error.code).toBe('NOT_DIARIZED')
  })

  it('treats malformed turns JSON as non-diarized: CSV gated, JSON still exports turns:null', async () => {
    setupTranscript({ turns: '{not json' })
    const csv = await callExport({ recordingId: 'rec1', format: 'csv' })
    expect(csv.success).toBe(false)
    expect(csv.error.code).toBe('NOT_DIARIZED')

    showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/out/My Meeting.json' })
    const json = await callExport({ recordingId: 'rec1', format: 'json' })
    expect(json.success).toBe(true)
    const written = writeFileSync.mock.calls[0][1] as string
    expect(JSON.parse(written).transcript.turns).toBeNull()
  })

  it('returns success(null) and writes nothing when the dialog is cancelled', async () => {
    setupTranscript()
    showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })
    const res = await callExport({ recordingId: 'rec1', format: 'json' })
    expect(res.success).toBe(true)
    expect(res.data).toBeNull()
    expect(writeFileSync).not.toHaveBeenCalled()
  })

  it('writes the formatter output to the chosen path and returns the path on success', async () => {
    setupTranscript()
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/out/My Meeting.csv' })
    const res = await callExport({ recordingId: 'rec1', format: 'csv' })
    expect(res.success).toBe(true)
    expect(res.data).toBe('/out/My Meeting.csv')
    expect(writeFileSync).toHaveBeenCalledTimes(1)
    const [path, content, enc] = writeFileSync.mock.calls[0]
    expect(path).toBe('/out/My Meeting.csv')
    expect(enc).toBe('utf-8')
    expect((content as string).charCodeAt(0)).toBe(0xfeff) // BOM
    expect(content as string).toContain('Alice Johnson,00:00:00.000,00:00:01.000,Hi')
  })

  it('serializes recording.title from the AI title chain (title_suggestion wins)', async () => {
    setupTranscript()
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/out/My Meeting.json' })
    const res = await callExport({ recordingId: 'rec1', format: 'json' })
    expect(res.success).toBe(true)
    const written = writeFileSync.mock.calls[0][1] as string
    const parsed = JSON.parse(written)
    // The exported record's title must follow the chain, not the raw on-disk filename.
    expect(parsed.recording.title).toBe('My Meeting')
  })

  it('serializes recording.title from the filename fallback (sans extension) when no AI title', async () => {
    setupTranscript({ title_suggestion: null }, { original_filename: 'My Recording.wav' })
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/out/My Recording.json' })
    const res = await callExport({ recordingId: 'rec1', format: 'json' })
    expect(res.success).toBe(true)
    const written = writeFileSync.mock.calls[0][1] as string
    const parsed = JSON.parse(written)
    expect(parsed.recording.title).toBe('My Recording')
  })

  it('proposes a sanitized default filename derived from the title', async () => {
    setupTranscript({ title_suggestion: 'a/b:c*?' })
    showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })
    await callExport({ recordingId: 'rec1', format: 'json' })
    const opts = showSaveDialog.mock.calls[0][1]
    expect(opts.defaultPath).toBe('abc.json')
  })

  it('falls back to the recording filename (sans extension) when title_suggestion is null', async () => {
    setupTranscript({ title_suggestion: null }, { original_filename: 'My Recording.wav' })
    showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })
    await callExport({ recordingId: 'rec1', format: 'json' })
    const opts = showSaveDialog.mock.calls[0][1]
    expect(opts.defaultPath).toBe('My Recording.json')
  })

  it('rejects an invalid format with VALIDATION_ERROR', async () => {
    setupTranscript()
    const res = await callExport({ recordingId: 'rec1', format: 'pdf' } as any)
    expect(res.success).toBe(false)
    expect(res.error.code).toBe('VALIDATION_ERROR')
  })
})
