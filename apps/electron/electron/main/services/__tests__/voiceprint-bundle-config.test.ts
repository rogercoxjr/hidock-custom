/**
 * Voiceprint bundle config — D4 (§6.7, §11). Guards the optionalDependency pin
 * and the electron-builder model bundling so a refactor can't silently drop them.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// voiceprint-service transitively pulls config -> file-storage -> database, whose
// DEFAULT_CONFIG calls app.getPath('home') at module load. Stub electron so importing
// the VOICEPRINT_MODEL_ID constant doesn't crash outside the real main process.
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/fake/app',
    getPath: (name: string) => (name === 'userData' ? '/fake/userdata' : '/fake/home'),
  },
}))

import { VOICEPRINT_MODEL_ID } from '../voiceprint-service'

const root = join(__dirname, '..', '..', '..', '..') // apps/electron

describe('voiceprint bundle config (§6.7, §11)', () => {
  it('1. sherpa-onnx-node is a version-pinned optionalDependency', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))
    expect(pkg.optionalDependencies?.['sherpa-onnx-node']).toBeDefined()
    // Pinned exact version (no ^ / ~ range — the prebuilt addon is platform-fragile).
    expect(pkg.optionalDependencies['sherpa-onnx-node']).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('2. electron-builder unpacks the ERes2Net model + ships it in extraResources', () => {
    const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf-8')
    expect(yml).toContain('3dspeaker_eres2net_en_voxceleb.onnx')
    expect(yml).toContain('resources/models')
    // The bundled filename must track the service constant — a future rename of
    // VOICEPRINT_MODEL_ID then forces the electron-builder.yml/bundling to update.
    expect(yml).toContain(`${VOICEPRINT_MODEL_ID}.onnx`)
  })
})
