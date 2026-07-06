/**
 * sync-reconcile - server-safe 4-layer reconciliation for sync status
 *
 * Extracted from download-service.ts so this logic can run in the hosted Fastify
 * server (plain Node, no electron in the boot path). This module only imports
 * from ./database and ./file-storage — both already server-safe.
 */

import { existsSync } from 'fs'
import { join, basename } from 'path'
import { isFileSynced, addSyncedFile, getRecordingByFilename } from './database'
import { getRecordingsPath } from './file-storage'

/**
 * B-DWN-003: Normalize .hda filenames to .mp3 extension
 * HiDock devices output .hda files which are actually MP3 format
 */
export function normalizeFilename(filename: string): string {
  return filename.replace(/\.hda$/i, '.mp3')
}

/**
 * Check if a file needs to be downloaded
 * Reconciles database, synced_files table, and actual files on disk
 * C-004: Also checks .mp3 normalized name (B-DWN-003 normalizes .hda->.mp3)
 */
export function isFileAlreadySynced(filename: string): { synced: boolean; reason: string } {
  if (isFileSynced(filename)) return { synced: true, reason: 'In synced_files table' }

  const wavFilename = filename.replace(/\.hda$/i, '.wav')
  if (wavFilename !== filename && isFileSynced(wavFilename)) {
    return { synced: true, reason: 'WAV version in synced_files' }
  }
  const mp3Filename = normalizeFilename(filename)
  if (mp3Filename !== filename && mp3Filename !== wavFilename && isFileSynced(mp3Filename)) {
    return { synced: true, reason: 'MP3 version in synced_files' }
  }

  const recordingsPath = getRecordingsPath()
  const wavPath = join(recordingsPath, wavFilename)
  if (existsSync(wavPath)) {
    addSyncedFile(filename, wavFilename, wavPath)
    return { synced: true, reason: 'File exists on disk (reconciled)' }
  }
  if (mp3Filename !== filename && mp3Filename !== wavFilename) {
    const mp3Path = join(recordingsPath, mp3Filename)
    if (existsSync(mp3Path)) {
      addSyncedFile(filename, mp3Filename, mp3Path)
      return { synced: true, reason: 'MP3 file exists on disk (reconciled)' }
    }
  }

  const recording = getRecordingByFilename(filename) || getRecordingByFilename(wavFilename)
  if (recording && recording.file_path && existsSync(recording.file_path)) {
    addSyncedFile(filename, basename(recording.file_path), recording.file_path)
    return { synced: true, reason: 'In recordings table with valid file' }
  }

  return { synced: false, reason: 'Not found anywhere' }
}
