/**
 * Config crypto tests — auto-pipeline P2, Task 1.
 *
 * Verifies: cold-start round-trip (save encrypted → reload decrypted),
 * __enc__ idempotency guard (no double-wrap), and defaults (new fields present).
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// ---------------------------------------------------------------------------
// Each test gets its own isolated temp dir so config files don't bleed over.
// ---------------------------------------------------------------------------
let currentTmpDir: string

beforeEach(() => {
  currentTmpDir = mkdtempSync(join(tmpdir(), 'hidock-cfg-crypto-'))
  vi.resetModules()

  // Reinstall the mock with the new per-test directory.
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('config — summarization section (auto-pipeline P3)', () => {
  it('1. defaults: fresh initializeConfig → summarization has correct defaults', async () => {
    const { initializeConfig, getConfig } = await import('../config')
    await initializeConfig()
    const cfg = getConfig()
    expect(cfg.summarization).toEqual({
      provider: 'gemini',
      ollamaCloudApiKey: '',
      ollamaCloudModel: '',
      selectorModel: ''
    })
  })

  it('2. cold-start round-trip for ollamaCloudApiKey: save → disk has __enc__ → reload decrypts', async () => {
    const { initializeConfig, saveConfig, getConfig } = await import('../config')

    await initializeConfig()

    // Save a config with an ollamaCloudApiKey
    const base = getConfig()
    await saveConfig({
      summarization: {
        ...base.summarization,
        ollamaCloudApiKey: 'ollama-secret-key'
      }
    })

    // Read the raw JSON from disk — the stored value must be encrypted
    const configPath = join(currentTmpDir, 'config.json')
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(raw.summarization.ollamaCloudApiKey).toMatch(/^__enc__/)
    expect(raw.summarization.ollamaCloudApiKey).not.toContain('ollama-secret-key')

    // Re-import fresh module state and reload from disk
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
    expect(mod2.getConfig().summarization.ollamaCloudApiKey).toBe('ollama-secret-key')
  })
})

describe('config — openaiApiKey crypto (auto-pipeline P2)', () => {
  it('1. cold-start round-trip: save → disk has __enc__ → reload decrypts', async () => {
    const { initializeConfig, saveConfig, getConfig } = await import('../config')

    await initializeConfig()

    // Save a config with an openaiApiKey
    const base = getConfig()
    await saveConfig({
      transcription: {
        ...base.transcription,
        openaiApiKey: 'sk-secret'
      }
    })

    // Read the raw JSON from disk — the stored value must be encrypted
    const configPath = join(currentTmpDir, 'config.json')
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(raw.transcription.openaiApiKey).toMatch(/^__enc__/)
    expect(raw.transcription.openaiApiKey).not.toContain('sk-secret')

    // Re-import fresh module state and reload from disk
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
    expect(mod2.getConfig().transcription.openaiApiKey).toBe('sk-secret')
  })

  it('2. __enc__ idempotency guard: encryptSensitive already-encrypted value returns unchanged', async () => {
    const { encryptSensitive } = await import('../config')
    const alreadyEncrypted = '__enc__abc'
    const result = encryptSensitive(alreadyEncrypted)
    expect(result).toBe('__enc__abc')
  })

  it('3. defaults: fresh initializeConfig → provider=gemini, whisperModel=whisper-1, openaiApiKey=""', async () => {
    const { initializeConfig, getConfig } = await import('../config')
    await initializeConfig()
    const cfg = getConfig()
    expect(cfg.transcription.provider).toBe('assemblyai') // D1 §6.2 flipped the default
    expect(cfg.transcription.whisperModel).toBe('whisper-1')
    expect(cfg.transcription.openaiApiKey).toBe('')
  })

  it('4. defaults: fresh initializeConfig → language defaults to English ("en")', async () => {
    const { initializeConfig, getConfig } = await import('../config')
    await initializeConfig()
    expect(getConfig().transcription.language).toBe('en')
  })
})
