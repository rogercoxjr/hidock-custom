import { FastifyInstance } from 'fastify'
import { ZodError } from 'zod'

export class HttpError extends Error {
  constructor(public statusCode: number, message: string) { super(message); this.name = new.target.name }
}
export class BadRequestError extends HttpError { constructor(m = 'bad request') { super(400, m) } }
export class NotFoundError extends HttpError { constructor(m = 'not found') { super(404, m) } }
export class ConflictError extends HttpError { constructor(m = 'conflict') { super(409, m) } }

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'invalid', details: err.flatten() })
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message })
    // Duck-type fallback: handles HttpError thrown from a different module instance (e.g. after vi.resetModules()),
    // plus Fastify's own 400 validation errors.
    const sc = (err as { statusCode?: number }).statusCode
    if (typeof sc === 'number' && sc >= 400 && sc < 600) return reply.code(sc).send({ error: err.message })
    app.log.error(err)
    return reply.code(500).send({ error: 'internal' })
  })
}
