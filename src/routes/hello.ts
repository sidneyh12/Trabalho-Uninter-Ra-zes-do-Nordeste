import type { FastifyInstance } from 'fastify'

export async function helloRoutes(app: FastifyInstance) {
  app.get('/', async (_request, reply) => {
    return reply.send('Hello World')
  })
}
