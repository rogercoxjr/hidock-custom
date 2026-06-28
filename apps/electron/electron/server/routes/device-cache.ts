import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getDatabase, queryAll, run } from '../../main/services/database'

interface CachedDeviceFile {
  filename: string
  size: number
  duration: number
  dateCreated: string
}

const putBody = z.object({
  files: z.array(
    z.object({
      filename: z.string(),
      size: z.number(),
      duration: z.number(),
      dateCreated: z.string()
    })
  )
})

export async function registerDeviceCache(app: FastifyInstance): Promise<void> {
  // GET /api/device-cache — return all cached device files
  app.get('/api/device-cache', { preHandler: [app.requireAuth] }, async () => {
    try {
      const files = queryAll<CachedDeviceFile>(
        'SELECT * FROM device_file_cache ORDER BY dateCreated DESC'
      )
      return files
    } catch {
      // Table might not exist yet
      return []
    }
  })

  // PUT /api/device-cache — replace the entire device file cache
  app.put(
    '/api/device-cache',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req) => {
      const { files } = putBody.parse(req.body)
      const db = getDatabase()

      // Create table if it doesn't exist (mirrors the IPC handler)
      db.exec(`
        CREATE TABLE IF NOT EXISTS device_file_cache (
          filename TEXT PRIMARY KEY,
          size INTEGER,
          duration REAL,
          dateCreated TEXT
        )
      `)

      // Clear existing cache then bulk-insert
      db.exec('DELETE FROM device_file_cache')

      const stmt = db.prepare(
        'INSERT INTO device_file_cache (filename, size, duration, dateCreated) VALUES (?, ?, ?, ?)'
      )
      for (const file of files) {
        stmt.run(file.filename, file.size, file.duration, file.dateCreated)
      }

      return { ok: true, count: files.length }
    }
  )

  // DELETE /api/device-cache — clear all cached device files
  app.delete(
    '/api/device-cache',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async () => {
      try {
        run('DELETE FROM device_file_cache')
      } catch {
        // Table might not exist — treat as already empty
      }
      return { ok: true }
    }
  )
}
