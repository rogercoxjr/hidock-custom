import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('headless foundation', () => {
  let dir: string
  beforeEach(() => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-boot-'))
    process.env.HIDOCK_DATA_ROOT = dir
  })
  afterEach(async () => {
    const { closeDatabase } = await import('../services/database')
    try { closeDatabase() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
    delete process.env.HIDOCK_DATA_ROOT
  })

  it('boots config + storage + db with no electron dependency', async () => {
    const { bootFoundation } = await import('../boot-foundation')
    await bootFoundation()
    const { queryOne } = await import('../services/database')
    expect(queryOne<{ version: number }>('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')?.version).toBe(33)
  })

  it('foundation modules contain no `from \'electron\'` import', () => {
    for (const f of ['services/config.ts', 'services/file-storage.ts', 'services/database.ts', 'runtime/env.ts', 'runtime/secrets.ts']) {
      const src = readFileSync(join(__dirname, '..', f), 'utf-8')
      expect(src, `${f} must not import electron`).not.toMatch(/from ['"]electron['"]/)
    }
  })
})
