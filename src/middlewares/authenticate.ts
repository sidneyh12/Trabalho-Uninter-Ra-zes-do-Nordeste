import type { FastifyReply, FastifyRequest } from 'fastify'

import { unauthorizedError } from '../http/errors.js'

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  try {
    await request.jwtVerify()
  } catch {
    return reply.status(401).send(unauthorizedError())
  }
}
