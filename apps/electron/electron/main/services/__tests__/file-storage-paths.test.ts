/**
 * FIX-013: Windows path case sensitivity in readRecordingFile
 *
 * BUG: readRecordingFile() and deleteRecording() use JavaScript's startsWith()
 * for path validation. On Windows, paths are case-insensitive but startsWith()
 * is case-sensitive. If paths come from different sources with different casing,
 * the security check fails silently and returns null.
 *
 * Example:
 *   recordingsPath = "C:\\Users\\Sebastian\\HiDock\\recordings"
 *   filePath from DB = "C:\\users\\sebastian\\hidock\\recordings\\test.wav"
 *   → startsWith() returns false → file read rejected
 */

import { describe, it, expect } from 'vitest'
import { normalize, resolve } from 'path'
import { readFileSync } from 'fs'
import { join } from 'path'

describe('FIX-013: Path case sensitivity', () => {
  it('demonstrates that startsWith is case-sensitive', () => {
    const upper = 'C:\\Users\\Sebastian\\HiDock\\recordings'
    const lower = 'C:\\users\\sebastian\\hidock\\recordings'

    // JavaScript startsWith is always case-sensitive
    expect(lower.startsWith(upper)).toBe(false)
    expect(upper.startsWith(lower)).toBe(false)

    // But case-insensitive comparison works
    expect(lower.toLowerCase().startsWith(upper.toLowerCase())).toBe(true)
  })

  it('should still reject paths outside allowed directories with case-insensitive check', () => {
    const recordingsPath = 'C:\\Users\\Sebastian\\HiDock\\recordings'
    const evilPath = 'C:\\Users\\Sebastian\\evil\\recordings\\test.wav'

    const normalizedEvil = normalize(resolve(evilPath))
    const normalizedRec = normalize(resolve(recordingsPath))

    const result = normalizedEvil.toLowerCase().startsWith(normalizedRec.toLowerCase())
    expect(result).toBe(false)
  })

  it('readRecordingFile enforces the case-insensitive guard (via isRecordingPathAllowed)', () => {
    // Read the actual source to verify the fix. The directory-allow check was
    // extracted into isRecordingPathAllowed (shared with the streaming media
    // protocol); readRecordingFile must delegate to it, and that guard must use
    // the case-insensitive comparison on Windows.
    const sourceFile = join(__dirname, '..', 'file-storage.ts')
    const source = readFileSync(sourceFile, 'utf-8')

    // readRecordingFile must call the shared guard.
    const readFn = source.slice(
      source.indexOf('export function readRecordingFile'),
      source.indexOf('\n}', source.indexOf('export function readRecordingFile')) + 2
    )
    expect(readFn).toContain('isRecordingPathAllowed')

    // The shared guard must do the case-insensitive comparison.
    const guardStart = source.indexOf('export function isRecordingPathAllowed')
    expect(guardStart).toBeGreaterThan(-1)
    const guardBody = source.slice(guardStart, source.indexOf('\n}', guardStart) + 2)
    expect(guardBody.includes('toLowerCase')).toBe(true)
  })

  it('deleteRecording uses case-insensitive path comparison on Windows', () => {
    const sourceFile = join(__dirname, '..', 'file-storage.ts')
    const source = readFileSync(sourceFile, 'utf-8')

    const funcStart = source.indexOf('export function deleteRecording')
    expect(funcStart).toBeGreaterThan(-1)
    const funcBody = source.slice(funcStart, source.indexOf('\n}', funcStart) + 2)

    const hasPathCaseInsensitive = funcBody.includes('toLowerCase')
    expect(hasPathCaseInsensitive).toBe(true)
  })
})
