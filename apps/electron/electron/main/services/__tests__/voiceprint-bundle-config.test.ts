/**
 * Voiceprint bundle config — D4 (§6.7, §11). Guards the optionalDependency pin
 * and the electron-builder model bundling so a refactor can't silently drop them.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

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
  })
})
