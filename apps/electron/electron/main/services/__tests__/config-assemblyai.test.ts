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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let currentTmpDir: string

beforeEach(() => {
  currentTmpDir = mkdtempSync(join(tmpdir(), 'hidock-cfg-aai-'))
  vi.resetModules()
  process.env.HIDOCK_DATA_ROOT = currentTmpDir
  delete process.env.HIDOCK_CONFIG_PATH
  process.env.HIDOCK_SECRET_KEY = 'test-key'
})

afterEach(() => {
  rmSync(currentTmpDir, { recursive: true, force: true })
  delete process.env.HIDOCK_DATA_ROOT
  delete process.env.HIDOCK_CONFIG_PATH
  delete process.env.HIDOCK_SECRET_KEY
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
    process.env.HIDOCK_DATA_ROOT = currentTmpDir
    delete process.env.HIDOCK_CONFIG_PATH
    process.env.HIDOCK_SECRET_KEY = 'test-key'
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
    // AES-GCM uses a random nonce, so ciphertexts differ across calls — toBe(once) is too strict.
    // What matters: second write is still a single-wrapped __enc__ token, never __enc____enc__.
    expect(once).toMatch(/^__enc__/)
    expect(twice).toMatch(/^__enc__/)
    expect(twice.startsWith('__enc____enc__')).toBe(false)
  })
})
