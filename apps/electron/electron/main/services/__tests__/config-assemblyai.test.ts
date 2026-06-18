/**
 * config — AssemblyAI fields (speaker-diarization D1, Task 2).
 *
 * Verifies: provider defaults to 'assemblyai' (§6.2), assemblyaiModels default,
 * assemblyaiApiKey defaults to '', and the cold-start round-trip (save → disk
 * has __enc__ → reload decrypts) for assemblyaiApiKey at BOTH sites
 * (saveConfig encrypt + initializeConfig decrypt) + __enc__ idempotency.
 * Mirrors config-crypto.test.ts.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let currentTmpDir: string

beforeEach(() => {
  currentTmpDir = mkdtempSync(join(tmpdir(), 'hidock-cfg-aai-'))
  vi.resetModules()
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
})

describe('config — AssemblyAI defaults (§6.2)', () => {
  it('fresh initializeConfig → provider=assemblyai, assemblyaiApiKey="", models default', async () => {
    const { initializeConfig, getConfig } = await import('../config')
    await initializeConfig()
    const cfg = getConfig()
    expect(cfg.transcription.provider).toBe('assemblyai')
    expect(cfg.transcription.assemblyaiApiKey).toBe('')
    expect(cfg.transcription.assemblyaiModels).toEqual(['universal-3-pro', 'universal-2'])
  })
})

describe('config — assemblyaiApiKey crypto (both sites)', () => {
  it('cold-start round-trip: save → disk has __enc__ → reload decrypts', async () => {
    const { initializeConfig, saveConfig, getConfig } = await import('../config')
    await initializeConfig()

    const base = getConfig()
    await saveConfig({
      transcription: { ...base.transcription, assemblyaiApiKey: 'aai-secret' }
    })

    const configPath = join(currentTmpDir, 'config.json')
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(raw.transcription.assemblyaiApiKey).toMatch(/^__enc__/)
    expect(raw.transcription.assemblyaiApiKey).not.toContain('aai-secret')

    vi.resetModules()
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
    const mod2 = await import('../config')
    await mod2.initializeConfig()
    expect(mod2.getConfig().transcription.assemblyaiApiKey).toBe('aai-secret')
  })

  it('__enc__ idempotency: an already-encrypted assemblyaiApiKey is not double-wrapped', async () => {
    const { initializeConfig, saveConfig, getConfig } = await import('../config')
    await initializeConfig()
    const base = getConfig()
    // First save encrypts.
    await saveConfig({ transcription: { ...base.transcription, assemblyaiApiKey: 'aai-secret' } })
    const configPath = join(currentTmpDir, 'config.json')
    const once = JSON.parse(readFileSync(configPath, 'utf-8')).transcription.assemblyaiApiKey
    // In-memory config now holds the decrypted value; a second save must not double-wrap.
    await saveConfig({ transcription: { ...getConfig().transcription } })
    const twice = JSON.parse(readFileSync(configPath, 'utf-8')).transcription.assemblyaiApiKey
    expect(twice).toBe(once)
    expect(twice.startsWith('__enc____enc__')).toBe(false)
  })
})
