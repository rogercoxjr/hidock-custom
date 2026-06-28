import { FastifyInstance } from 'fastify'
import { ZodError } from 'zod'

export class HttpError extends Error {
  readonly __httpError = true as const
  constructor(public statusCode: number, message: string) { super(message); this.name = new.target.name }
}
export class BadRequestError extends HttpError { constructor(m = 'bad request') { super(400, m) } }
export class ForbiddenError extends HttpError { constructor(m = 'forbidden') { super(403, m) } }
export class NotFoundError extends HttpError { constructor(m = 'not found') { super(404, m) } }
export class ConflictError extends HttpError { constructor(m = 'conflict') { super(409, m) } }
export class UnprocessableEntityError extends HttpError { constructor(m = 'unprocessable entity') { super(422, m) } }

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'invalid', details: err.flatten() })
    const e = err as { __httpError?: boolean; statusCode?: number; validation?: unknown; message: string }
    if (e.__httpError === true && typeof e.statusCode === 'number') {
      return reply.code(e.statusCode).send({ error: e.message })
    }
    // Fastify's own JSON-schema validation errors (precise signal, not a broad statusCode check)
    if (e.validation) return reply.code(400).send({ error: e.message })
    app.log.error(err)
    return reply.code(500).send({ error: 'internal' })
  })
}
