import { execFile } from 'child_process'
import { promisify } from 'util'
import { app } from 'electron'
import { mkdirSync, rmSync, statSync, readdirSync, statfsSync } from 'fs'
import { join, basename } from 'path'
import { tmpdir } from 'os'
// @ts-ignore - ffmpeg-static has no types (monorepo precedent: meeting-recorder)
import ffmpegStaticPath from 'ffmpeg-static'

const execFileAsync = promisify(execFile)
const ASR_TMP = join(tmpdir(), 'hidock-asr')
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024 // 24 MB guard under OpenAI's 25 MB limit (spec §5.1)
const SEGMENT_SECONDS = 600

/** ffmpeg-static resolves inside app.asar in packaged builds; binaries cannot
 *  execute from the archive — rewrite to app.asar.unpacked (spec §5.1/§9). */
export function resolveFfmpegPath(): string {
  if (!ffmpegStaticPath) {
    throw new Error('ffmpeg binary not found (ffmpeg-static resolved to null). Reinstall: npm install ffmpeg-static')
  }
  return app.isPackaged
    ? String(ffmpegStaticPath).replace('app.asar', 'app.asar.unpacked')
    : String(ffmpegStaticPath)
}

/** Always-transcode (spec §5.1): EVERY Whisper input is normalized to 16 kHz
 *  mono 32 kbps MP3 (1 h ≈ 14 MB) — one code path, deterministic container
 *  (P1 .hda format is unverified; raw bytes never reach OpenAI). If the result
 *  still exceeds 24 MB, segment into 600 s chunks. Throws a non-retryable
 *  disk-space error before spawning when free space < 2× input size. */
export async function normalizeForWhisper(inputPath: string): Promise<{ files: string[] }> {
  const inputBase = basename(inputPath)

  // Disk guard: check free space before spawning ffmpeg
  try {
    const inputSize = statSync(inputPath).size
    const stats = statfsSync(tmpdir())
    const freeBytes = stats.bavail * stats.bsize
    if (freeBytes < inputSize * 2) {
      throw new Error(`Not enough disk space to process ${inputBase}`)
    }
  } catch (e) {
    // Re-throw disk space errors (non-retryable); skip guard on platforms
    // where statfsSync is unavailable (guard is best-effort)
    if ((e as Error).message.startsWith('Not enough disk space')) {
      throw e
    }
    // statfsSync failed on this platform — proceed without the guard
  }

  // Ensure temp directory exists BEFORE invoking ffmpeg (test 8)
  mkdirSync(ASR_TMP, { recursive: true })

  const outPath = join(ASR_TMP, `${inputBase}.norm.mp3`)

  // Transcode to 16 kHz mono 32 kbps MP3
  const ffmpeg = resolveFfmpegPath()
  const transcodeArgs = ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', '-b:a', '32k', outPath]

  try {
    await execFileAsync(ffmpeg, transcodeArgs)
  } catch (e) {
    throw new Error(`ffmpeg failed for ${inputBase}: ${String((e as { stderr?: string }).stderr ?? (e as Error).message).slice(-200)}`)
  }

  // Check size of transcoded output — segment if > 24 MB
  const outSize = statSync(outPath).size
  if (outSize <= MAX_UPLOAD_BYTES) {
    return { files: [outPath] }
  }

  // Segment into 600-second chunks
  const segmentPattern = join(ASR_TMP, `${inputBase}.part%03d.mp3`)
  const segmentArgs = [
    '-y', '-i', outPath,
    '-f', 'segment',
    '-segment_time', String(SEGMENT_SECONDS),
    '-c', 'copy',
    segmentPattern
  ]

  try {
    await execFileAsync(ffmpeg, segmentArgs)
  } catch (e) {
    throw new Error(`ffmpeg failed for ${inputBase}: ${String((e as { stderr?: string }).stderr ?? (e as Error).message).slice(-200)}`)
  }

  // Collect segment files from the temp directory
  const segFiles = readdirSync(ASR_TMP)
    .filter((entry) => {
      const name = typeof entry === 'string' ? entry : (entry as { name: string }).name
      return name.startsWith(inputBase + '.part') && name.endsWith('.mp3')
    })
    .map((entry) => {
      const name = typeof entry === 'string' ? entry : (entry as { name: string }).name
      return join(ASR_TMP, name)
    })
    .sort()

  return { files: segFiles }
}

/** Wiped at app startup (index.ts) and after each job (worker). */
export function cleanAsrTempDir(): void {
  rmSync(ASR_TMP, { recursive: true, force: true })
}
