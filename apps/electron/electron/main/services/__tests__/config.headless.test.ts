import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('config (headless)', () => {
  let dir: string
  beforeEach(() => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-cfg-'))
    process.env.HIDOCK_DATA_ROOT = dir
    delete process.env.HIDOCK_CONFIG_PATH
    process.env.HIDOCK_SECRET_KEY = 'test-key'
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.HIDOCK_DATA_ROOT
    delete process.env.HIDOCK_CONFIG_PATH
    delete process.env.HIDOCK_SECRET_KEY
  })

  it('initializes a config file and defaults dataPath to the data root', async () => {
    const { initializeConfig, getConfig, getDataPath } = await import('../config')
    await initializeConfig()
    expect(existsSync(join(dir, 'config.json'))).toBe(true)
    expect(getDataPath()).toBe(dir)
    expect(getConfig().version).toBeTruthy()
  })

  it('persists a sensitive field encrypted, reads it back decrypted', async () => {
    const cfg = await import('../config')
    await cfg.initializeConfig()
    await cfg.updateConfig('transcription', { assemblyaiApiKey: 'secret-abc' })
    const raw = readFileSync(join(dir, 'config.json'), 'utf-8')
    expect(raw).not.toContain('secret-abc')        // encrypted on disk
    expect(cfg.getConfig().transcription.assemblyaiApiKey).toBe('secret-abc') // decrypted in memory
  })

  it('imports without pulling in electron', async () => {
    const mod = await import('../config')
    expect(typeof mod.getConfigPath).toBe('function')
  })
})
