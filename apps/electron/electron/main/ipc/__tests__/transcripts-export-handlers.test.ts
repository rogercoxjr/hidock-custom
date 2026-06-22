/**
 * @vitest-environment node
 *
 * Tests for the `transcripts:export` IPC handler (Task 5).
 *
 * Dialog and fs are mocked so tests run without Electron or the filesystem.
 * The formatter module (transcript-export.ts) is left un-mocked — the handler
 * delegates to the real pure functions, which are already unit-tested in
 * transcript-export.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ipcMain } from 'electron'
import { registerTranscriptsExportHandlers } from '../transcripts-export-handlers'

// ── Electron mocks ────────────────────────────────────────────────────────────
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() }
}))

// ── fs mock — only writeFileSync needed ──────────────────────────────────────
vi.mock('fs', () => ({
  writeFileSync: vi.fn()
}))

// ── Database mock ─────────────────────────────────────────────────────────────
vi.mock('../../services/database', () => ({
  getRecordingById: vi.fn(),
  getTranscriptByRecordingId: vi.fn(),
  getRecordingSpeakers: vi.fn(),
  getContactById: vi.fn()
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal Recording fixture. */
function makeRecording(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'rec-1',
    filename: 'Weekly Sync.m4a',
    date_recorded: '2026-06-22T10:00:00.000Z',
    duration_seconds: 123,
    ...overrides
  }
}

/** Minimal Transcript fixture — non-diarized (no turns). */
function makeTranscript(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'tr-1',
    recording_id: 'rec-1',
    full_text: 'Hello world',
    language: 'en',
    summary: 'A short meeting.',
    action_items: JSON.stringify(['Ship it']),
    topics: JSON.stringify(['release']),
    key_points: JSON.stringify(['went well']),
    title_suggestion: 'Weekly Sync',
    sentiment: null,
    transcription_provider: 'assemblyai',
    transcription_model: 'best',
    turns: null,
    ...overrides
  }
}

/** Two-turn diarized transcript. */
function makeTurns() {
  return JSON.stringify([
    { speaker: 'Speaker_0', startMs: 0, endMs: 1000, text: 'Hello' },
    { speaker: 'Speaker_1', startMs: 1000, endMs: 2000, text: 'Hi there' }
  ])
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('transcripts:export IPC handler', () => {
  let handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
  let mockDialog: { showSaveDialog: ReturnType<typeof vi.fn> }
  let mockBrowserWindow: { fromWebContents: ReturnType<typeof vi.fn> }
  let mockWriteFileSync: ReturnType<typeof vi.fn>
  let mockDb: {
    getRecordingById: ReturnType<typeof vi.fn>
    getTranscriptByRecordingId: ReturnType<typeof vi.fn>
    getRecordingSpeakers: ReturnType<typeof vi.fn>
    getContactById: ReturnType<typeof vi.fn>
  }

  const fakeEvent = { sender: {} }
  const fakeWin = { id: 1 }

  beforeEach(async () => {
    vi.clearAllMocks()
    handlers = {}

    vi.mocked(ipcMain.handle).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (channel: string, handler: (...args: any[]) => any) => {
        handlers[channel] = handler
        return undefined as any
      }
    )

    // Pull mocked modules AFTER clearing so we get fresh references
    const electron = await import('electron')
    const fs = await import('fs')
    const db = await import('../../services/database')

    mockDialog = electron.dialog as unknown as typeof mockDialog
    mockBrowserWindow = electron.BrowserWindow as unknown as typeof mockBrowserWindow
    mockWriteFileSync = fs.writeFileSync as unknown as ReturnType<typeof vi.fn>
    mockDb = db as unknown as typeof mockDb

    // Default: window always resolves
    mockBrowserWindow.fromWebContents.mockReturnValue(fakeWin)
    // Default: speakers returns empty array (no mapped names)
    mockDb.getRecordingSpeakers.mockReturnValue([])
    // Default: contactById returns undefined (no name to map)
    mockDb.getContactById.mockReturnValue(undefined)

    registerTranscriptsExportHandlers()
  })

  // ── Registration ─────────────────────────────────────────────────────────────

  it('registers the transcripts:export channel', () => {
    expect(ipcMain.handle).toHaveBeenCalledWith('transcripts:export', expect.any(Function))
  })

  // ── NOT_FOUND — no recording ──────────────────────────────────────────────────

  it('returns NOT_FOUND when the recording does not exist', async () => {
    mockDb.getRecordingById.mockReturnValue(undefined)
    mockDb.getTranscriptByRecordingId.mockReturnValue(undefined)

    const result = await handlers['transcripts:export'](fakeEvent, {
      recordingId: 'no-such-id',
      format: 'json'
    }) as { success: boolean; error?: { code: string } }

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NOT_FOUND')
  })

  // ── NOT_FOUND — no transcript ─────────────────────────────────────────────────

  it('returns NOT_FOUND when there is no transcript for the recording', async () => {
    mockDb.getRecordingById.mockReturnValue(makeRecording())
    mockDb.getTranscriptByRecordingId.mockReturnValue(undefined)

    const result = await handlers['transcripts:export'](fakeEvent, {
      recordingId: 'rec-1',
      format: 'json'
    }) as { success: boolean; error?: { code: string } }

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NOT_FOUND')
  })

  // ── NOT_DIARIZED gate — csv ───────────────────────────────────────────────────

  it('returns NOT_DIARIZED for csv when transcript has no turns', async () => {
    mockDb.getRecordingById.mockReturnValue(makeRecording())
    mockDb.getTranscriptByRecordingId.mockReturnValue(makeTranscript({ turns: null }))

    const result = await handlers['transcripts:export'](fakeEvent, {
      recordingId: 'rec-1',
      format: 'csv'
    }) as { success: boolean; error?: { code: string } }

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NOT_DIARIZED')
    // writeFileSync must NOT have been called
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })

  // ── NOT_DIARIZED gate — srt ───────────────────────────────────────────────────

  it('returns NOT_DIARIZED for srt when transcript has no turns', async () => {
    mockDb.getRecordingById.mockReturnValue(makeRecording())
    mockDb.getTranscriptByRecordingId.mockReturnValue(makeTranscript({ turns: null }))

    const result = await handlers['transcripts:export'](fakeEvent, {
      recordingId: 'rec-1',
      format: 'srt'
    }) as { success: boolean; error?: { code: string } }

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NOT_DIARIZED')
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })

  // ── NOT_DIARIZED gate — empty turns array ─────────────────────────────────────

  it('returns NOT_DIARIZED for csv when turns is an empty array', async () => {
    mockDb.getRecordingById.mockReturnValue(makeRecording())
    mockDb.getTranscriptByRecordingId.mockReturnValue(makeTranscript({ turns: JSON.stringify([]) }))

    const result = await handlers['transcripts:export'](fakeEvent, {
      recordingId: 'rec-1',
      format: 'csv'
    }) as { success: boolean; error?: { code: string } }

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NOT_DIARIZED')
  })

  // ── Cancel → success(null) — no write ─────────────────────────────────────────

  it('returns success(null) when the save dialog is cancelled and does not write the file', async () => {
    mockDb.getRecordingById.mockReturnValue(makeRecording())
    mockDb.getTranscriptByRecordingId.mockReturnValue(makeTranscript())
    mockDialog.showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })

    const result = await handlers['transcripts:export'](fakeEvent, {
      recordingId: 'rec-1',
      format: 'json'
    }) as { success: boolean; data: unknown }

    expect(result.success).toBe(true)
    expect(result.data).toBeNull()
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })

  // ── Success — json export ─────────────────────────────────────────────────────

  it('writes the formatted JSON and returns the file path on success', async () => {
    mockDb.getRecordingById.mockReturnValue(makeRecording())
    mockDb.getTranscriptByRecordingId.mockReturnValue(makeTranscript())
    mockDialog.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: '/home/user/Weekly Sync.json'
    })

    const result = await handlers['transcripts:export'](fakeEvent, {
      recordingId: 'rec-1',
      format: 'json'
    }) as { success: boolean; data: string }

    expect(result.success).toBe(true)
    expect(result.data).toBe('/home/user/Weekly Sync.json')

    // writeFileSync must have been called with the path and valid JSON content
    expect(mockWriteFileSync).toHaveBeenCalledOnce()
    const [writtenPath, writtenContent] = mockWriteFileSync.mock.calls[0] as [string, string, string]
    expect(writtenPath).toBe('/home/user/Weekly Sync.json')
    const parsed = JSON.parse(writtenContent)
    expect(parsed.version).toBe(1)
    expect(parsed.recording.id).toBe('rec-1')
  })

  // ── Success — csv export (diarized) ──────────────────────────────────────────

  it('writes a CSV and returns the path when turns are present', async () => {
    mockDb.getRecordingById.mockReturnValue(makeRecording())
    mockDb.getTranscriptByRecordingId.mockReturnValue(makeTranscript({ turns: makeTurns() }))
    mockDialog.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: '/home/user/Weekly Sync.csv'
    })

    const result = await handlers['transcripts:export'](fakeEvent, {
      recordingId: 'rec-1',
      format: 'csv'
    }) as { success: boolean; data: string }

    expect(result.success).toBe(true)
    expect(result.data).toBe('/home/user/Weekly Sync.csv')

    const [, writtenContent] = mockWriteFileSync.mock.calls[0] as [string, string, string]
    // Should contain the CSV header and data rows
    expect(writtenContent).toContain('speaker,start,end,text')
  })

  // ── Success — srt export (diarized) ──────────────────────────────────────────

  it('writes an SRT and returns the path when turns are present', async () => {
    mockDb.getRecordingById.mockReturnValue(makeRecording())
    mockDb.getTranscriptByRecordingId.mockReturnValue(makeTranscript({ turns: makeTurns() }))
    mockDialog.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: '/home/user/Weekly Sync.srt'
    })

    const result = await handlers['transcripts:export'](fakeEvent, {
      recordingId: 'rec-1',
      format: 'srt'
    }) as { success: boolean; data: string }

    expect(result.success).toBe(true)
    expect(result.data).toBe('/home/user/Weekly Sync.srt')

    const [, writtenContent] = mockWriteFileSync.mock.calls[0] as [string, string, string]
    // SRT has numeric cue index followed by timestamp arrow
    expect(writtenContent).toContain('-->')
  })

  // ── Malformed turns JSON does not throw ──────────────────────────────────────

  it('does not throw when turns contains malformed JSON and falls back to not-diarized', async () => {
    mockDb.getRecordingById.mockReturnValue(makeRecording())
    mockDb.getTranscriptByRecordingId.mockReturnValue(
      makeTranscript({ turns: '{not valid json[[[' })
    )

    // Requesting csv should trigger NOT_DIARIZED (malformed → null turns)
    const result = await handlers['transcripts:export'](fakeEvent, {
      recordingId: 'rec-1',
      format: 'csv'
    }) as { success: boolean; error?: { code: string } }

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NOT_DIARIZED')
    // Crucially — no unhandled throw
  })

  // ── Malformed analysis JSON ───────────────────────────────────────────────────

  it('does not throw when analysis fields contain malformed JSON — defaults to empty arrays', async () => {
    mockDb.getRecordingById.mockReturnValue(makeRecording())
    mockDb.getTranscriptByRecordingId.mockReturnValue(
      makeTranscript({
        action_items: 'not-json',
        topics: null,
        key_points: undefined
      })
    )
    mockDialog.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: '/tmp/out.json'
    })

    const result = await handlers['transcripts:export'](fakeEvent, {
      recordingId: 'rec-1',
      format: 'json'
    }) as { success: boolean; data?: string }

    expect(result.success).toBe(true)
    const parsed = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string)
    expect(parsed.analysis.actionItems).toEqual([])
    expect(parsed.analysis.topics).toEqual([])
    expect(parsed.analysis.keyPoints).toEqual([])
  })

  // ── Default filename uses title_suggestion ────────────────────────────────────

  it('passes title_suggestion (sanitized) as the defaultPath to the save dialog', async () => {
    mockDb.getRecordingById.mockReturnValue(makeRecording())
    mockDb.getTranscriptByRecordingId.mockReturnValue(
      makeTranscript({ title_suggestion: 'Q2 Review: Budget & Planning' })
    )
    mockDialog.showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })

    await handlers['transcripts:export'](fakeEvent, { recordingId: 'rec-1', format: 'json' })

    const [, opts] = mockDialog.showSaveDialog.mock.calls[0] as [unknown, { defaultPath: string }]
    // Colons are illegal on Windows — sanitiseBasename strips them
    expect(opts.defaultPath).not.toContain(':')
    expect(opts.defaultPath).toMatch(/\.json$/)
  })

  // ── Title fallback: filename extension is stripped ────────────────────────────

  it('strips the recording filename extension when falling back to it for the default filename', async () => {
    mockDb.getRecordingById.mockReturnValue(
      makeRecording({ filename: '2026-06-22_meeting.m4a' })
    )
    mockDb.getTranscriptByRecordingId.mockReturnValue(
      makeTranscript({ title_suggestion: '' }) // empty → fall back to filename
    )
    mockDialog.showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })

    await handlers['transcripts:export'](fakeEvent, { recordingId: 'rec-1', format: 'json' })

    const [, opts] = mockDialog.showSaveDialog.mock.calls[0] as [unknown, { defaultPath: string }]
    // Should NOT contain ".m4a" in the stem
    expect(opts.defaultPath).not.toContain('.m4a')
    // Should end with the requested format extension
    expect(opts.defaultPath).toMatch(/\.json$/)
  })

  // ── Speaker names resolved from contacts ──────────────────────────────────────

  it('maps speaker labels to contact names in the exported JSON', async () => {
    mockDb.getRecordingById.mockReturnValue(makeRecording())
    mockDb.getTranscriptByRecordingId.mockReturnValue(makeTranscript())
    mockDb.getRecordingSpeakers.mockReturnValue([
      {
        recording_id: 'rec-1',
        file_label: 'Speaker_0',
        contact_id: 'cid-alice',
        confidence: 1.0,
        source: 'user',
        created_at: '2026-06-22T00:00:00Z'
      }
    ])
    mockDb.getContactById.mockReturnValue({ id: 'cid-alice', name: 'Alice Johnson' })
    mockDialog.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: '/tmp/out.json'
    })

    const result = await handlers['transcripts:export'](fakeEvent, {
      recordingId: 'rec-1',
      format: 'json'
    }) as { success: boolean }

    expect(result.success).toBe(true)
    const parsed = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string)
    expect(parsed.speakers).toEqual({ Speaker_0: 'Alice Johnson' })
  })

  // ── VALIDATION_ERROR for unknown format ───────────────────────────────────────

  it('returns VALIDATION_ERROR for an unknown format string', async () => {
    mockDb.getRecordingById.mockReturnValue(makeRecording())
    mockDb.getTranscriptByRecordingId.mockReturnValue(makeTranscript())

    const result = await handlers['transcripts:export'](fakeEvent, {
      recordingId: 'rec-1',
      format: 'pdf'
    }) as { success: boolean; error?: { code: string } }

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('VALIDATION_ERROR')
  })
})
