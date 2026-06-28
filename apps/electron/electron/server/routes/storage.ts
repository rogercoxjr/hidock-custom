import { FastifyInstance } from 'fastify'
import { getStorageInfo } from '../../main/services/file-storage'

export async function registerStorage(app: FastifyInstance): Promise<void> {
  app.get('/api/storage/info', { preHandler: [app.requireAuth] }, async () => {
    return getStorageInfo()
  })
}
