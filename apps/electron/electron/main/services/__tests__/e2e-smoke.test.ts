/**
 * E2E integration smoke test — Gate 3 of the "primetime" effort.
 *
 * Exercises the REAL cross-service knowledge pipeline end to end with a REAL
 * in-memory sql.js database and a REAL temp audio file on disk:
 *
 *   Stage 1  device list -> persist recording   (real database.upsertRecordingFromDevice)
 *   Stage 4  calendar sync -> meetings           (real calendar-sync.syncCalendar + real ICS parse)
 *   Stage 2  download -> save file + sync status (real download-service.processDownload + real saveRecording)
 *   Stage 3  transcribe -> transcript + AI link  (real transcription.transcribeManually)
 *
 * Only external boundaries are mocked (electron, config persistence, the file-storage
 * path resolvers, Gemini SDK, the Ollama-backed vector store, and the USB jensen device).
 * Everything else — sql.js, fs, ./database, ./download-service, ./transcription,
 * ./calendar-sync — runs its real implementation.
 */
// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'

// ---------------------------------------------------------------------------
// Hoisted shared state — created before the mock factories run.
// vi.hoisted() guarantees this executes before the (also hoisted) vi.mock()
// factories below, so the path resolvers can close over a real temp dir.
// ---------------------------------------------------------------------------
const shared = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _os = require('os') as typeof import('os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _fs = require('fs') as typeof import('fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _path = require('path') as typeof import('path')

  const tmpDir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'hidock-e2e-'))
  const dataDir = _path.join(tmpDir, 'data')
  const recordingsDir = _path.join(tmpDir, 'recordings')
  _fs.mkdirSync(dataDir, { recursive: true })
  _fs.mkdirSync(recordingsDir, { recursive: true })

  return {
    tmpDir,
    dataDir,
    recordingsDir,
    // DB file path that does NOT exist yet -> initializeDatabase builds a fresh schema.
    // Its parent (dataDir) DOES exist so saveDatabase()'s writeFileSync succeeds.
    dbPath: _path.join(dataDir, 'hidock.db'),
    // Mutable: set AFTER calendar sync so the Gemini analysis mock can select the real meeting id.
    selectedMeetingId: '' as string
  }
})

// The ICS feed the real calendar-sync will fetch+parse. The VEVENT window
// (14:00–15:00Z) overlaps the recording's date_recorded (14:00Z) so
// findCandidateMeetingsForRecording returns exactly this meeting.
const ICS_FIXTURE = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//hidock-e2e//EN',
  'CALSCALE:GREGORIAN',
  'BEGIN:VEVENT',
  'UID:e2e-team-standup@hidock.test',
  'DTSTAMP:20240608T130000Z',
  'DTSTART:20240608T140000Z',
  'DTEND:20240608T150000Z',
  'SUMMARY:Team Standup',
  'ORGANIZER;CN=Roger Cox:mailto:rcox@example.com',
  'END:VEVENT',
  'END:VCALENDAR',
  ''
].join('\r\n')

const ANALYSIS_JSON = () =>
  JSON.stringify({
    summary: 'The team held its standup and reviewed Q3 goals and sprint planning.',
    action_items: ['Finalize Q3 OKRs'],
    topics: ['standup', 'sprint planning'],
    key_points: ['Q3 goals discussed'],
    title_suggestion: 'Team Standup',
    question_suggestions: ['What was decided about Q3 goals?'],
    language: 'en',
    selected_meeting_id: shared.selectedMeetingId,
    meeting_confidence: 0.9,
    selection_reason: 'subject + time match'
  })

// ---------------------------------------------------------------------------
// External-boundary mocks (declared before imports; vi.mock is hoisted).
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => os.tmpdir()),
    getName: vi.fn(() => 'test')
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() },
  Notification: { isSupported: vi.fn(() => false) }
}))

vi.mock('../config', () => ({
  getConfig: vi.fn(() => ({
    storage: { dataPath: shared.tmpDir, maxRecordingsGB: 50 },
    transcription: {
      provider: 'gemini',
      geminiApiKey: 'test-key',
      geminiModel: 'gemini-2.0-flash',
      autoTranscribe: false, // we drive transcription manually in the test
      language: 'en'
    },
    // Auto-pipeline P3 (spec §5.4): drives the Stage-2 LLM factory.
    summarization: {
      provider: 'gemini',
      ollamaCloudApiKey: '',
      ollamaCloudModel: ''
    },
    calendar: {
      icsUrl: 'https://example.com/cal.ics',
      syncEnabled: true,
      syncIntervalMinutes: 15,
      lastSyncAt: null
    }
  })),
  updateConfig: vi.fn(async () => {}),
  getDataPath: vi.fn(() => shared.tmpDir)
}))

vi.mock('../file-storage', () => ({
  getDatabasePath: vi.fn(() => shared.dbPath),
  getRecordingsPath: vi.fn(() => shared.recordingsDir),
  getCachePath: vi.fn(() => os.tmpdir()),
  // Real on-disk write — transcribeRecording does existsSync(file_path) + readFileAsync(file_path).
  saveRecording: vi.fn(async (filename: string, data: Buffer) => {
    const out = path.join(shared.recordingsDir, filename.replace(/\.hda$/i, '.mp3'))
    fs.writeFileSync(out, data)
    return out
  })
}))

vi.mock('../vector-store', () => ({
  // Returning null avoids any Ollama embedding work; transcription's indexing
  // step is wrapped in try/catch and fails gracefully.
  getVectorStore: vi.fn(() => null)
}))

vi.mock('@google/generative-ai', () => {
  const generateContent = vi.fn(async (arg: unknown) => {
    if (Array.isArray(arg)) {
      // Transcription call (inlineData audio + prompt).
      return {
        response: {
          text: () => 'Team standup transcript: discussed Q3 goals and sprint planning.'
        }
      }
    }
    // String calls: the analysis prompt AND the later actionable-detection prompt.
    // Returning the analysis JSON object satisfies the analysis parser; the
    // actionable detector greps for a JSON array and finds none -> fails gracefully.
    return { response: { text: () => ANALYSIS_JSON() } }
  })
  class GoogleGenerativeAI {
    getGenerativeModel() {
      return { generateContent }
    }
  }
  return { GoogleGenerativeAI }
})

// USB device boundary — represents the "connect + list files" step without hardware.
const REC_FILENAME = 'REC_20240608.hda'
const AUDIO_BYTES = Buffer.from('fake-audio-bytes')
vi.mock('../jensen', () => ({
  getJensenDevice: vi.fn(() => ({
    listFiles: vi.fn(async () => [
      {
        name: REC_FILENAME,
        length: AUDIO_BYTES.length,
        duration: 1800,
        createDate: '2024-06-08',
        time: new Date('2024-06-08T14:00:00Z')
      }
    ])
  }))
}))

// ---------------------------------------------------------------------------
// Real service imports (resolved AFTER the mocks above).
// ---------------------------------------------------------------------------
import {
  initializeDatabase,
  closeDatabase,
  upsertRecordingFromDevice,
  getRecordingById,
  getTranscriptByRecordingId,
  getMeetingById,
  getMeetings,
  getRecordingsForMeeting
} from '../database'
import { getDownloadService } from '../download-service'
import { transcribeManually } from '../transcription'
import { syncCalendar } from '../calendar-sync'
import { getJensenDevice } from '../jensen'

describe('E2E knowledge pipeline smoke test (real services)', () => {
  let originalFetch: typeof global.fetch

  beforeEach(async () => {
    // Ensure a clean temp layout for this run.
    fs.mkdirSync(shared.dataDir, { recursive: true })
    fs.mkdirSync(shared.recordingsDir, { recursive: true })
    if (fs.existsSync(shared.dbPath)) fs.rmSync(shared.dbPath)

    // Fresh fetch mock per test: serve the ICS fixture to the real calendar-sync.
    originalFetch = global.fetch
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => ICS_FIXTURE
    })) as unknown as typeof fetch

    // No seeding: the db file does not exist, so initializeDatabase() builds the
    // full schema from scratch — this exercises (and guards) the real first-launch path.
  })

  afterEach(() => {
    try {
      // Stop the download service's internal stalled-check interval so vitest can exit cleanly.
      getDownloadService().destroy()
    } catch {
      /* singleton may not be created */
    }
    try {
      closeDatabase()
    } catch {
      /* ignore */
    }
    vi.restoreAllMocks()
    global.fetch = originalFetch
    try {
      fs.rmSync(shared.tmpDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('connects+lists, syncs calendar, downloads, transcribes, and correlates — all via real DB', async () => {
    // --- Boot a fresh real sql.js database (db file does not exist) ---
    await initializeDatabase()

    // --- Stage 1: device connect + list -> persist recording ---------------
    // Represent the USB list boundary, then persist via the REAL database fn
    // exactly as the device-list IPC handler does.
    const listed = await getJensenDevice().listFiles()
    expect(listed).toBeTruthy()
    expect(listed![0].name).toBe(REC_FILENAME)

    const rec = upsertRecordingFromDevice({
      filename: REC_FILENAME,
      size: AUDIO_BYTES.length,
      duration: 1800,
      dateCreated: new Date('2024-06-08T14:00:00Z')
    })
    expect(rec.id).toBeTruthy()
    expect(rec.location).toBe('device-only')

    // --- Stage 4 FIRST: calendar sync so the meeting exists for correlation -
    const syncResult = await syncCalendar('https://example.com/cal.ics')
    expect(syncResult.success).toBe(true)
    expect(syncResult.meetingsCount).toBe(1)

    const meeting = getMeetings()[0]
    expect(meeting).toBeTruthy()
    expect(meeting.subject).toBe('Team Standup')
    // The Gemini analysis mock reads this to "select" the matching meeting.
    shared.selectedMeetingId = meeting.id

    // --- Stage 2: download -> real file write + sync-status reconciliation --
    const svc = getDownloadService()
    svc.queueDownloads([
      {
        filename: rec.filename,
        size: AUDIO_BYTES.length, // must equal data.length to pass the integrity check
        dateCreated: new Date('2024-06-08T14:00:00Z')
      }
    ])
    const dl = await svc.processDownload(rec.filename, AUDIO_BYTES)
    expect(dl.success).toBe(true)
    expect(dl.filePath).toBeTruthy()
    expect(fs.existsSync(dl.filePath!)).toBe(true)

    // --- Stage 3: transcribe (reads the real file, calls Gemini, correlates) -
    await transcribeManually(rec.id)

    // --- Assertions against the REAL database -----------------------------
    const finalRec = getRecordingById(rec.id)
    expect(finalRec).toBeDefined()
    expect(finalRec!.location).toBe('both')
    expect(finalRec!.transcription_status).toBe('complete')
    expect(finalRec!.file_path).toBeTruthy()
    expect(finalRec!.meeting_id).toBe(meeting.id)
    expect(finalRec!.correlation_method).toBe('ai_transcript_match')
    expect(finalRec!.correlation_confidence).toBeGreaterThanOrEqual(0.4)

    const transcript = getTranscriptByRecordingId(rec.id)
    expect(transcript).toBeDefined()
    expect(transcript!.recording_id).toBe(rec.id)
    expect(transcript!.full_text.toLowerCase()).toContain('team standup')

    const meetingRow = getMeetingById(meeting.id)
    expect(meetingRow).toBeDefined()
    expect(meetingRow!.subject).toBe('Team Standup')

    const recordingsForMeeting = getRecordingsForMeeting(meeting.id)
    expect(recordingsForMeeting.map(r => r.id)).toContain(rec.id)
  })
})
