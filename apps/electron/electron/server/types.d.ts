import { preHandlerHookHandler } from 'fastify'
import { AppDeps } from './app'

declare module 'fastify' {
  interface FastifyInstance {
    appDeps: AppDeps
    requireAuth: preHandlerHookHandler
    requireAdmin: preHandlerHookHandler
    requireSameOrigin: preHandlerHookHandler
  }
  interface FastifyRequest {
    user?: { email: string; role: 'admin' | 'member' }
  }
}
