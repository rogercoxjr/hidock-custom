import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * OLLAMA_URL boot override (plan 0f Task 6). Inside a container the config
 * default http://localhost:11434 points at the container itself, so the operator
 * sets OLLAMA_URL to the host/sibling Ollama. The override is written into
 * config.embeddings.ollamaBaseUrl (the RAG/embeddings Ollama endpoint) at boot,
 * because the embedding code reads config, not the env directly.
 */
describe('OLLAMA_URL boot override', () => {
  let dir: string
  beforeEach(() => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-ollama-'))
    process.env.HIDOCK_DATA_ROOT = dir
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.HIDOCK_DATA_ROOT
    delete process.env.OLLAMA_URL
  })

  it('writes OLLAMA_URL into the embeddings ollama base url when set', async () => {
    process.env.OLLAMA_URL = 'http://host.docker.internal:11434'
    const cfg = await import('../../main/services/config')
    await cfg.initializeConfig()
    const { applyEnvOverrides } = await import('../index')
    await applyEnvOverrides()
    expect(cfg.getConfig().embeddings.ollamaBaseUrl).toBe('http://host.docker.internal:11434')
  })

  it('leaves config untouched when OLLAMA_URL is unset', async () => {
    delete process.env.OLLAMA_URL
    const cfg = await import('../../main/services/config')
    await cfg.initializeConfig()
    const before = cfg.getConfig().embeddings.ollamaBaseUrl
    const { applyEnvOverrides } = await import('../index')
    await applyEnvOverrides()
    expect(cfg.getConfig().embeddings.ollamaBaseUrl).toBe(before)
  })
})
