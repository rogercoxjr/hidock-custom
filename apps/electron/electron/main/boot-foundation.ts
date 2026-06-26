import { initializeConfig } from './services/config'
import { initializeFileStorage } from './services/file-storage'
import { initializeDatabase } from './services/database'

/**
 * Headless boot of the data foundation, in dependency order:
 * config (paths/secrets) → file storage (dirs) → database (better-sqlite3, schema v33).
 * Used by the Fastify server entry in sub-plan 0b. No Electron.
 */
export async function bootFoundation(): Promise<void> {
  await initializeConfig()
  await initializeFileStorage()
  await initializeDatabase()
}
