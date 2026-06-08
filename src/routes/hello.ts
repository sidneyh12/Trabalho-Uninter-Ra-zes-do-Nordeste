import type { FastifyInstance } from 'fastify'

import { authenticate } from '../middlewares/authenticate.js'

export async function helloRoutes(app: FastifyInstance) {
  app.get(
    '/hello',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['hello'],
        summary: 'Hello autenticado',
        description: 'Rota de exemplo protegida por JWT Bearer.',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            required: ['message'],
            properties: {
              message: { type: 'string' },
            },
          },
          401: {
            type: 'object',
            required: ['error', 'message'],
            properties: {
              error: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      return reply.status(200).send({
        message: 'Ola mundo autenticado com JWT.',
      })
    },
  )
}
