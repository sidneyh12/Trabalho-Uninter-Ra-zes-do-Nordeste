import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import jwt from '@fastify/jwt'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'

import { env } from './env/index.js'
import { authRoutes } from './routes/auth.js'
import { helloRoutes } from './routes/hello.js'

export const app = fastify()

app.register(jwt, {
  secret: env.JWT_SECRET,
})

app.register(swagger, {
  openapi: {
    openapi: '3.0.3',
    info: {
      title: 'Raízes do Nordeste API',
      description: 'API REST para a rede Raízes do Nordeste.',
      version: '1.0.0',
    },
    servers: [{ url: '/v1', description: 'Versão atual da API' }],
    tags: [
      { name: 'auth', description: 'Autenticação' },
      { name: 'hello', description: 'Rotas de exemplo' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    },
  },
})

async function registerV1Routes(instance: FastifyInstance) {
  await instance.register(authRoutes, { prefix: '/auth' })
  await instance.register(helloRoutes)
}

app.register(registerV1Routes, { prefix: '/v1' })

app.register(swaggerUi, {
  routePrefix: '/documentation',
})
