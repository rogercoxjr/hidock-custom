import { FastifyInstance } from 'fastify'
import { readFileSync } from 'fs'
import { join } from 'path'

// Read version + name from package.json once at module load time.
// The server process runs from within the apps/electron tree; climb up from
// __dirname (electron/server/routes/) to the package root.
function readPkg(): { version: string; name: string } {
  try {
    const raw = readFileSync(join(__dirname, '../../../package.json'), 'utf-8')
    const parsed = JSON.parse(raw) as { version?: string; name?: string }
    return {
      version: parsed.version ?? '0.0.0',
      name: parsed.name ?? 'hidock'
    }
  } catch {
    return { version: '0.0.0', name: 'hidock' }
  }
}

const pkg = readPkg()

export async function registerAppInfo(app: FastifyInstance): Promise<void> {
  // GET /api/app/info
  // Mirrors the Electron `app:info` IPC channel: { version, name, isPackaged, platform }.
  // In the server context `isPackaged` is always false (no Electron runtime).
  app.get('/api/app/info', { preHandler: [app.requireAuth] }, async () => {
    return {
      version: pkg.version,
      name: pkg.name,
      isPackaged: false,
      platform: process.platform
    }
  })
}
