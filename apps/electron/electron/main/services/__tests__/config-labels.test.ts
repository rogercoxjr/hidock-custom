/**
 * config — Smart Labels taxonomy (v1).
 *
 * Verifies: fresh config seeds the six built-in labels; deepMerge BACK-FILLS
 * labels into a pre-existing config.json that lacks the key; and a user-edited
 * labels.items array survives a reload (deepMerge replaces arrays wholesale, so
 * user add/remove/rename is not clobbered by the seed).
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let currentTmpDir: string

function mockElectron(): void {
  vi.mock('electron', () => ({
    app: {
      getPath: (name: string) => {
        if (name === 'userData') return currentTmpDir
        if (name === 'home') return currentTmpDir
        return currentTmpDir
      }
    },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from('ENC:' + s),
      decryptString: (b: Buffer) => b.toString().replace(/^ENC:/, '')
    }
  }))
}

beforeEach(() => {
  currentTmpDir = mkdtempSync(join(tmpdir(), 'hidock-cfg-labels-'))
  vi.resetModules()
  mockElectron()
})

describe('config — Smart Labels defaults', () => {
  it('fresh initializeConfig seeds the six built-in labels with ids/colors', async () => {
    const { initializeConfig, getConfig, BUILTIN_LABELS } = await import('../config')
    await initializeConfig()
    const cfg = getConfig()

    expect(cfg.labels).toBeDefined()
    expect(cfg.labels.items).toHaveLength(6)

    const ids = cfg.labels.items.map((l) => l.id)
    expect(ids).toEqual(['meeting', 'interview', '1:1', 'brainstorm', 'note', 'other'])

    // All built-ins are flagged builtin and carry a palette token color.
    for (const item of cfg.labels.items) {
      expect(item.builtin).toBe(true)
      expect(typeof item.color).toBe('string')
      expect(item.color.length).toBeGreaterThan(0)
    }
    // Source-of-truth seed matches what's persisted.
    expect(cfg.labels.items.map((l) => l.id)).toEqual(BUILTIN_LABELS.map((l) => l.id))
  })

  it('deepMerge BACK-FILLS labels into a pre-existing config.json that lacks the key', async () => {
    // Simulate an existing user whose config.json predates Smart Labels.
    const legacy = {
      version: '1.0.0',
      transcription: { provider: 'gemini', geminiApiKey: 'AIza-existing' }
      // no `labels` key
    }
    writeFileSync(join(currentTmpDir, 'config.json'), JSON.stringify(legacy), 'utf-8')

    const { initializeConfig, getConfig } = await import('../config')
    await initializeConfig()
    const cfg = getConfig()

    // Pre-existing field preserved...
    expect(cfg.transcription.geminiApiKey).toBe('AIza-existing')
    // ...and labels back-filled from defaults.
    expect(cfg.labels.items).toHaveLength(6)
    expect(cfg.labels.items.find((l) => l.id === 'meeting')?.name).toBe('Meeting')
  })

  it('a user-edited labels.items array survives reload (seed does not clobber edits)', async () => {
    const userConfig = {
      version: '1.0.0',
      labels: {
        items: [
          { id: 'meeting', name: 'Standup', color: 'teal', builtin: true }, // renamed + recolored
          { id: 'sales-call', name: 'Sales Call', color: 'green' } // user-added
        ]
      }
    }
    writeFileSync(join(currentTmpDir, 'config.json'), JSON.stringify(userConfig), 'utf-8')

    const { initializeConfig, getConfig } = await import('../config')
    await initializeConfig()
    const cfg = getConfig()

    // deepMerge replaces arrays wholesale → exactly the user's two items, not the seed of six.
    expect(cfg.labels.items).toHaveLength(2)
    expect(cfg.labels.items.find((l) => l.id === 'meeting')?.name).toBe('Standup')
    expect(cfg.labels.items.find((l) => l.id === 'sales-call')?.name).toBe('Sales Call')
  })
})
