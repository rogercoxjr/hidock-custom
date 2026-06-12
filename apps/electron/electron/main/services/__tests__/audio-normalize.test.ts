/**
 * audio-normalize tests — auto-pipeline P2, Task 2.
 *
 * Verifies: ffmpeg path resolution (asar rewrite), always-transcode to 16kHz
 * mono 32kbps MP3, segmentation on >24MB output, disk guard, temp-dir hygiene,
 * ffmpeg failure wrapping, and mkdirSync-before-execFile ordering.
 *
 * All fs/execFile calls are mocked — no real ffmpeg invocations.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join, basename } from 'path'

// ---------------------------------------------------------------------------
// Hoisted controllable state + constants — must exist before vi.mock factories.
// ---------------------------------------------------------------------------
const { shared, FAKE_FFMPEG_PATH, FAKE_FFMPEG_UNPACKED, ASR_TMP } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _os = require('os') as typeof import('os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _path = require('path') as typeof import('path')

  const FAKE_FFMPEG_PATH = '/fake/app.asar/node_modules/ffmpeg-static/ffmpeg'
  const FAKE_FFMPEG_UNPACKED = '/fake/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg'
  const ASR_TMP = _path.join(_os.tmpdir(), 'hidock-asr')

  const shared = {
    isPackaged: false as boolean,
    execFileReject: null as null | { message: string; stderr: string },
    transcodeSize: 10 * 1024 * 1024 as number, // 10 MB by default
    segmentFiles: [] as string[],
    freeSpaceBytes: 200 * 1024 * 1024 as number, // 200 MB free by default
    inputSize: 5 * 1024 * 1024 as number, // 5 MB input by default
    callOrder: [] as string[]
  }

  return { shared, FAKE_FFMPEG_PATH, FAKE_FFMPEG_UNPACKED, ASR_TMP }
})

// ---------------------------------------------------------------------------
// Mock: electron — isPackaged controlled via shared.isPackaged
// ---------------------------------------------------------------------------
vi.mock('electron', () => ({
  app: new Proxy({}, {
    get: (_target: Record<string, unknown>, prop: string | symbol) => {
      if (prop === 'isPackaged') return shared.isPackaged
      return undefined
    }
  })
}))

// ---------------------------------------------------------------------------
// Mock: ffmpeg-static — return the controllable fake path
// ---------------------------------------------------------------------------
vi.mock('ffmpeg-static', () => ({
  default: FAKE_FFMPEG_PATH
}))

// ---------------------------------------------------------------------------
// Mock: child_process — execFile
// The module uses promisify(execFile), so promisify will call:
//   execFile(bin, args, callback)   <-- only 2 non-callback args in our calls
// The callback is always the LAST argument received.
// ---------------------------------------------------------------------------
vi.mock('child_process', () => {
  const execFile = vi.fn((...args: unknown[]) => {
    // callback is always the last argument
    const callback = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void
    shared.callOrder.push('execFile')
    if (shared.execFileReject) {
      const err = Object.assign(new Error(shared.execFileReject!.message), {
        stderr: shared.execFileReject!.stderr
      })
      callback(err, '', shared.execFileReject!.stderr)
    } else {
      callback(null, '', '')
    }
    return { pid: 1 }
  })
  return { execFile }
})

// ---------------------------------------------------------------------------
// Mock: fs — statSync, statfsSync, mkdirSync, rmSync, readdirSync
// ---------------------------------------------------------------------------
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('fs')
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn((..._args: unknown[]) => {
      shared.callOrder.push('mkdir')
    }),
    rmSync: vi.fn(),
    statSync: vi.fn((p: string) => {
      // The transcoded output (.norm.mp3) uses transcodeSize; input uses inputSize
      if (String(p).includes('.norm.mp3')) {
        return { size: shared.transcodeSize }
      }
      return { size: shared.inputSize }
    }),
    readdirSync: vi.fn((_dir: string) => {
      // Return segment filenames as objects with a .name property (Dirent-like)
      return shared.segmentFiles.map((name) => ({
        name,
        isFile: () => true
      }))
    }),
    statfsSync: vi.fn((_path: string) => {
      const blockSize = 4096
      return {
        bavail: Math.floor(shared.freeSpaceBytes / blockSize),
        bsize: blockSize
      }
    })
  }
})

// ---------------------------------------------------------------------------
// Import the module under test AFTER all mocks are declared.
// ---------------------------------------------------------------------------
import { resolveFfmpegPath, normalizeForWhisper, cleanAsrTempDir } from '../asr/audio-normalize'
import { execFile } from 'child_process'
import { rmSync } from 'fs'

// ---------------------------------------------------------------------------
// Reset shared state before each test
// ---------------------------------------------------------------------------
beforeEach(() => {
  shared.isPackaged = false
  shared.execFileReject = null
  shared.transcodeSize = 10 * 1024 * 1024
  shared.segmentFiles = []
  shared.freeSpaceBytes = 200 * 1024 * 1024
  shared.inputSize = 5 * 1024 * 1024
  shared.callOrder = []
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveFfmpegPath()', () => {
  it('1a. unpackaged: returns the raw ffmpeg-static path', () => {
    shared.isPackaged = false
    expect(resolveFfmpegPath()).toBe(FAKE_FFMPEG_PATH)
  })

  it('1b. packaged: replaces app.asar with app.asar.unpacked', () => {
    shared.isPackaged = true
    expect(resolveFfmpegPath()).toBe(FAKE_FFMPEG_UNPACKED)
  })
})

describe('normalizeForWhisper()', () => {
  it('3. single-file: calls ffmpeg with -ar 16000 -ac 1 -b:a 32k, returns { files: [outPath] }', async () => {
    const inputPath = '/recordings/meeting.hda'
    const expectedOut = join(ASR_TMP, `${basename(inputPath)}.norm.mp3`)

    const result = await normalizeForWhisper(inputPath)

    // execFile called exactly once (transcode only — output ≤ 24 MB, no segmentation)
    expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1)
    const args = vi.mocked(execFile).mock.calls[0][1] as string[]
    expect(args).toContain('-ar')
    expect(args).toContain('16000')
    expect(args).toContain('-ac')
    expect(args).toContain('1')
    expect(args).toContain('-b:a')
    expect(args).toContain('32k')
    expect(args).toContain(expectedOut)

    expect(result.files).toHaveLength(1)
    expect(result.files[0]).toBe(expectedOut)
  })

  it('4. >24MB output: second ffmpeg call with segment flags, returns segment file paths', async () => {
    shared.transcodeSize = 25 * 1024 * 1024 // 25 MB > 24 MB limit
    const segFiles = ['meeting.hda.part000.mp3', 'meeting.hda.part001.mp3', 'meeting.hda.part002.mp3']
    shared.segmentFiles = segFiles

    const inputPath = '/recordings/meeting.hda'
    const result = await normalizeForWhisper(inputPath)

    // Two execFile calls: transcode + segment
    expect(vi.mocked(execFile)).toHaveBeenCalledTimes(2)

    const secondArgs = vi.mocked(execFile).mock.calls[1][1] as string[]
    expect(secondArgs).toContain('-f')
    expect(secondArgs).toContain('segment')
    expect(secondArgs).toContain('-segment_time')
    expect(secondArgs).toContain('600')

    expect(result.files).toHaveLength(3)
    expect(result.files[0]).toContain('part000')
    expect(result.files[1]).toContain('part001')
    expect(result.files[2]).toContain('part002')
  })

  it('5. disk guard: throws "Not enough disk space" when free < 2× input; ffmpeg never called', async () => {
    shared.inputSize = 10 * 1024 * 1024    // 10 MB input
    shared.freeSpaceBytes = 15 * 1024 * 1024 // 15 MB free — less than 2×10 = 20 MB

    await expect(normalizeForWhisper('/recordings/big.hda')).rejects.toThrow(
      /Not enough disk space to process big\.hda/
    )
    expect(vi.mocked(execFile)).not.toHaveBeenCalled()
  })

  it('7. ffmpeg failure: throws "ffmpeg failed for <basename>:" with stderr tail', async () => {
    const longStderr = 'a'.repeat(300) + 'STDERR_TAIL_END'
    shared.execFileReject = { message: 'exit code 1', stderr: longStderr }

    let caught: Error | null = null
    try {
      await normalizeForWhisper('/recordings/test.hda')
    } catch (e) {
      caught = e as Error
    }
    expect(caught).not.toBeNull()
    expect(caught!.message).toMatch(/^ffmpeg failed for test\.hda:/)
    expect(caught!.message).toContain('STDERR_TAIL_END')
  })

  it('8. mkdirSync called BEFORE first ffmpeg invocation (assert call order)', async () => {
    await normalizeForWhisper('/recordings/order.hda')

    const mkdirIdx = shared.callOrder.indexOf('mkdir')
    const execFileIdx = shared.callOrder.indexOf('execFile')
    expect(mkdirIdx).toBeGreaterThanOrEqual(0)
    expect(execFileIdx).toBeGreaterThanOrEqual(0)
    expect(mkdirIdx).toBeLessThan(execFileIdx)
  })
})

describe('cleanAsrTempDir()', () => {
  it('6. removes the hidock-asr temp dir with recursive + force flags', () => {
    cleanAsrTempDir()
    expect(vi.mocked(rmSync)).toHaveBeenCalledWith(ASR_TMP, { recursive: true, force: true })
  })
})
