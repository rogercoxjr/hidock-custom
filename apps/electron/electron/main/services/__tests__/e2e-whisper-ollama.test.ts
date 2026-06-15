/**
 * Whisper + Ollama integration e2e — auto-pipeline P6 (spec 2026-06-11 §8 → AC1).
 *
 * The integration sibling of e2e-smoke.test.ts: same fixture architecture (REAL
 * in-memory sql.js, REAL temp audio file on disk, boundary mocks only) but
 * configured for the headline provider split —
 *   transcription.provider = 'openai-whisper'   (Stage 1 ASR)
 *   summarization.provider  = 'ollama-cloud'     (Stage 2 analysis)
 *
 * It exercises the REAL chain end to end against the real DB:
 *   download -> save file (download-service.processDownload + saveRecording)
 *   transcribe -> Stage 1 (real whisper-asr -> real audio-normalize w/ mocked
 *                 child_process ffmpeg) -> Stage 2 (real ollama-cloud-llm)
 *
 * Mocked boundaries ONLY: electron, config persistence, file-storage path
 * resolvers, vector-store, the Gemini SDK (never instantiated on this path), the
 * USB jensen device, `child_process` (ffmpeg), and global `fetch` (routed by URL
 * to the OpenAI + Ollama HTTP shapes). Everything else — sql.js, fs, ./database,
 * ./download-service, ./transcription, ./asr/*, ./llm/* — runs for real.
 *
 * Asserts the per-stage provider/model columns, the COALESCE language contract
 * end to end (Whisper-supplied language is NOT overwritten by the analysis JSON),
 * the request shapes (Bearer auth + multipart model on OpenAI; Bearer + format
 * json on Ollama), and the AC5 failure seam (missing LLM key -> Stage 1 paid work
 * preserved, Stage 2 marker NULL = resumable).
 */
// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'

// ---------------------------------------------------------------------------
// Hoisted shared state — created before the (also hoisted) mock factories run,
// so the path resolvers and the config mock can close over a real temp dir and
// a mutable provider config.
// ---------------------------------------------------------------------------
const shared = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _os = require('os') as typeof import('os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _fs = require('fs') as typeof import('fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _path = require('path') as typeof import('path')

  const tmpDir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'hidock-e2e-wo-'))
  const dataDir = _path.join(tmpDir, 'data')
  const recordingsDir = _path.join(tmpDir, 'recordings')
  _fs.mkdirSync(dataDir, { recursive: true })
  _fs.mkdirSync(recordingsDir, { recursive: true })

  return {
    tmpDir,
    dataDir,
    recordingsDir,
    // DB file path that does NOT exist yet -> initializeDatabase builds a fresh schema.
    dbPath: _path.join(dataDir, 'hidock.db'),
    // Mutable per-test: lets the failure-seam test blank the Ollama key.
    ollamaCloudApiKey: 'ok-test' as string
  }
})

// ---------------------------------------------------------------------------
// External-boundary mocks (declared before imports; vi.mock is hoisted).
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => os.tmpdir()),
    getName: vi.fn(() => 'test'),
    isPackaged: false // ffmpeg-static path: dev layout, no app.asar rewrite
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() },
  Notification: { isSupported: vi.fn(() => false) }
}))

// Full, self-contained config mock for this file (the Step-1 note: e2e-smoke's
// mock carries `summarization` but NOT the Whisper key fields — write a fresh one).
vi.mock('../config', () => ({
  getConfig: vi.fn(() => ({
    storage: { dataPath: shared.tmpDir, maxRecordingsGB: 50 },
    transcription: {
      provider: 'openai-whisper',
      openaiApiKey: 'sk-test',
      whisperModel: 'whisper-1',
      geminiApiKey: '',
      geminiModel: 'gemini-2.0-flash-exp',
      autoTranscribe: false, // transcription is driven manually in the test
      language: 'es'
    },
    summarization: {
      provider: 'ollama-cloud',
      ollamaCloudApiKey: shared.ollamaCloudApiKey,
      ollamaCloudModel: 'gpt-oss:120b'
    },
    calendar: {
      icsUrl: '',
      syncEnabled: false,
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
  // Real on-disk write — processDownload -> saveRecording; the worker then reads
  // recording.file_path. .hda is rewritten to .mp3 (mirrors e2e-smoke).
  saveRecording: vi.fn(async (filename: string, data: Buffer) => {
    const out = path.join(shared.recordingsDir, filename.replace(/\.hda$/i, '.mp3'))
    fs.writeFileSync(out, data)
    return out
  })
}))

vi.mock('../vector-store', () => ({
  // Returning null avoids any Ollama embedding work; the worker's indexing step
  // is wrapped in try/catch and fails gracefully.
  getVectorStore: vi.fn(() => null)
}))

// The Gemini SDK is never instantiated on the whisper+ollama path; mock it so the
// import graph never pulls in the real package (parity with e2e-smoke).
vi.mock('@google/generative-ai', () => {
  class GoogleGenerativeAI {
    getGenerativeModel() {
      return {
        generateContent: vi.fn(async () => ({ response: { text: () => '' } }))
      }
    }
  }
  return { GoogleGenerativeAI }
})

// USB device boundary — the "connect + list files" step without hardware.
const REC_FILENAME = 'REC_20240701.hda'
const AUDIO_BYTES = Buffer.from('fake-audio-bytes-for-whisper-ollama-e2e')
vi.mock('../jensen', () => ({
  getJensenDevice: vi.fn(() => ({
    listFiles: vi.fn(async () => [
      {
        name: REC_FILENAME,
        length: AUDIO_BYTES.length,
        duration: 1800,
        createDate: '2024-07-01',
        time: new Date('2024-07-01T14:00:00Z')
      }
    ])
  }))
}))

// ffmpeg boundary — the REAL audio-normalize runs, but its `child_process`
// `execFile` (consumed via promisify at import time) is mocked. Two wiring
// requirements (spec §5.1 / plan Step 2):
//   (1) honor the Node callback convention — cb(null, {stdout, stderr}); a plain
//       resolved-value vi.fn would hang the promisified await forever.
//   (2) write a small (≤24 MB) real file at the derived outPath BEFORE calling
//       back, so the subsequent statSync(outPath) finds it (single-chunk path).
vi.mock('child_process', () => ({
  execFile: vi.fn(
    (
      _file: string,
      args: string[],
      cb: (err: Error | null, res: { stdout: string; stderr: string }) => void
    ) => {
      // ffmpeg arg layout from audio-normalize.ts: the transcode invocation is
      // ['-y','-i',inputPath,'-ar','16000','-ac','1','-b:a','32k',outPath] — the
      // OUTPUT path is the last positional arg. Write a tiny real MP3-ish file
      // there so the size check (statSync) succeeds and stays under 24 MB.
      const outPath = args[args.length - 1]
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const _fs = require('fs') as typeof import('fs')
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const _path = require('path') as typeof import('path')
      _fs.mkdirSync(_path.dirname(outPath), { recursive: true })
      _fs.writeFileSync(outPath, Buffer.from('normalized-mp3-bytes'))
      cb(null, { stdout: '', stderr: '' })
    }
  )
}))

// ---------------------------------------------------------------------------
// Fetch routing (set per test in beforeEach). The whisper+ollama chain makes
// TWO kinds of HTTP calls; route by URL:
//   api.openai.com/v1/audio/transcriptions -> verbose_json transcript
//   ollama.com/api/chat                    -> analysis (1st) then actionables (2nd)
// Capture the requests so the test can assert auth headers + body shapes.
// ---------------------------------------------------------------------------
interface CapturedFetch {
  url: string
  init: RequestInit
}

function makeFetchMock(captured: CapturedFetch[]): typeof fetch {
  let ollamaCall = 0
  return vi.fn(async (url: string, init: RequestInit) => {
    captured.push({ url, init })
    if (url.includes('api.openai.com/v1/audio/transcriptions')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ text: 'WHISPER TRANSCRIPT TEXT', language: 'english' }),
        text: async () => ''
      }
    }
    if (url.includes('ollama.com/api/chat')) {
      ollamaCall += 1
      // 1st call = analysis (full JSON object); 2nd call = actionables ([]).
      const content =
        ollamaCall === 1
          ? JSON.stringify({
              summary: 'OLLAMA SUMMARY',
              action_items: ['a1'],
              topics: ['t'],
              key_points: ['k'],
              title_suggestion: 'Title',
              question_suggestions: ['q?'],
              language: 'en'
            })
          : '[]'
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ message: { content } }),
        text: async () => ''
      }
    }
    throw new Error(`Unexpected fetch URL in e2e-whisper-ollama: ${url}`)
  }) as unknown as typeof fetch
}

// ---------------------------------------------------------------------------
// Real service imports (resolved AFTER the mocks above).
// ---------------------------------------------------------------------------
import {
  initializeDatabase,
  closeDatabase,
  upsertRecordingFromDevice,
  getRecordingById,
  getTranscriptByRecordingId
} from '../database'
import { getDownloadService } from '../download-service'
import { transcribeManually } from '../transcription'
import { getJensenDevice } from '../jensen'

describe('E2E whisper+ollama integration (real services, per-stage providers)', () => {
  let originalFetch: typeof global.fetch
  let captured: CapturedFetch[]

  beforeEach(async () => {
    fs.mkdirSync(shared.dataDir, { recursive: true })
    fs.mkdirSync(shared.recordingsDir, { recursive: true })
    if (fs.existsSync(shared.dbPath)) fs.rmSync(shared.dbPath)
    shared.ollamaCloudApiKey = 'ok-test'

    captured = []
    originalFetch = global.fetch
    global.fetch = makeFetchMock(captured)

    await initializeDatabase()
  })

  afterEach(() => {
    try {
      getDownloadService().destroy()
    } catch {
      /* singleton may not be created */
    }
    try {
      closeDatabase()
    } catch {
      /* ignore */
    }
    vi.clearAllMocks()
    global.fetch = originalFetch
    try {
      fs.rmSync(shared.tmpDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('downloads, transcribes via Whisper, summarizes via Ollama Cloud — full chain, per-stage columns, COALESCE language', async () => {
    // --- Stage 1: device connect + list -> persist recording -----------------
    const listed = await getJensenDevice().listFiles()
    expect(listed![0].name).toBe(REC_FILENAME)

    const rec = upsertRecordingFromDevice({
      filename: REC_FILENAME,
      size: AUDIO_BYTES.length,
      duration: 1800,
      dateCreated: new Date('2024-07-01T14:00:00Z')
    })
    expect(rec.id).toBeTruthy()

    // --- Stage 2: download -> real file write --------------------------------
    const svc = getDownloadService()
    svc.queueDownloads([
      {
        filename: rec.filename,
        size: AUDIO_BYTES.length, // must equal data.length to pass the integrity check
        dateCreated: new Date('2024-07-01T14:00:00Z')
      }
    ])
    const dl = await svc.processDownload(rec.filename, AUDIO_BYTES)
    expect(dl.success).toBe(true)
    expect(fs.existsSync(dl.filePath!)).toBe(true)

    // --- Stage 3: transcribe (real whisper-asr -> real audio-normalize w/
    //     mocked ffmpeg -> real ollama-cloud-llm) ----------------------------
    await transcribeManually(rec.id)

    // --- Assertions against the REAL database --------------------------------
    const transcript = getTranscriptByRecordingId(rec.id)
    expect(transcript).toBeDefined()
    expect(transcript!.full_text).toBe('WHISPER TRANSCRIPT TEXT')
    expect(transcript!.summary).toBe('OLLAMA SUMMARY')
    expect(transcript!.transcription_provider).toBe('openai-whisper')
    expect(transcript!.transcription_model).toBe('whisper-1')
    expect(transcript!.summarization_provider).toBe('ollama-cloud')
    expect(transcript!.summarization_model).toBe('gpt-oss:120b')
    // COALESCE contract end to end: Stage 1 (Whisper) supplied 'english'; Stage 2
    // must NOT overwrite it with the analysis JSON's 'en'.
    expect(transcript!.language).toBe('english')

    const finalRec = getRecordingById(rec.id)
    expect(finalRec!.transcription_status).toBe('complete')

    // --- Request-shape assertions --------------------------------------------
    const openaiReq = captured.find((c) => c.url.includes('api.openai.com/v1/audio/transcriptions'))
    expect(openaiReq).toBeDefined()
    expect((openaiReq!.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
    const form = openaiReq!.init.body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect(form.get('model')).toBe('whisper-1')
    expect(form.get('response_format')).toBe('verbose_json')

    const ollamaReq = captured.find((c) => c.url.includes('ollama.com/api/chat'))
    expect(ollamaReq).toBeDefined()
    expect((ollamaReq!.init.headers as Record<string, string>).Authorization).toBe('Bearer ok-test')
    const ollamaBody = JSON.parse(ollamaReq!.init.body as string)
    expect(ollamaBody.model).toBe('gpt-oss:120b')
    expect(ollamaBody.format).toBe('json')
  })

  it('AC5 failure seam: missing Ollama key -> Whisper Stage 1 preserved, Stage 2 marker NULL (resumable)', async () => {
    shared.ollamaCloudApiKey = '' // blank the LLM key for this run

    const rec = upsertRecordingFromDevice({
      filename: REC_FILENAME,
      size: AUDIO_BYTES.length,
      duration: 1800,
      dateCreated: new Date('2024-07-01T14:00:00Z')
    })

    const svc = getDownloadService()
    svc.queueDownloads([
      { filename: rec.filename, size: AUDIO_BYTES.length, dateCreated: new Date('2024-07-01T14:00:00Z') }
    ])
    const dl = await svc.processDownload(rec.filename, AUDIO_BYTES)
    expect(dl.success).toBe(true)

    // Stage 1 (Whisper) runs and persists; Stage 2 (Ollama) key check throws.
    await expect(transcribeManually(rec.id)).rejects.toThrow(/Ollama Cloud API key not configured/)

    const transcript = getTranscriptByRecordingId(rec.id)
    expect(transcript).toBeDefined()
    expect(transcript!.full_text).toBe('WHISPER TRANSCRIPT TEXT') // paid ASR work preserved
    expect(transcript!.summarization_provider ?? null).toBeNull() // Stage 2 never completed -> resumable
    expect(transcript!.summary ?? null).toBeNull() // no sentinel written

    // The Ollama endpoint was never reached (key check throws before any fetch).
    expect(captured.some((c) => c.url.includes('ollama.com/api/chat'))).toBe(false)
    // But the OpenAI transcription DID happen (Stage 1 ran).
    expect(captured.some((c) => c.url.includes('api.openai.com/v1/audio/transcriptions'))).toBe(true)
  })
})
