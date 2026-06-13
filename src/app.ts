import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import jwt from '@fastify/jwt'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'

import { env } from './env/index.js'
import { authRoutes } from './routes/auth.js'
import { estoqueRoutes } from './routes/estoque.js'
import { helloRoutes } from './routes/hello.js'
import { movimentacoesEstoqueRoutes } from './routes/movimentacoes-estoque.js'
import { produtosRoutes } from './routes/produtos.js'
import { unidadesRoutes } from './routes/unidades.js'
import { usersRoutes } from './routes/users.js'

// coerceTypes: quando vem ?page=1 na URL, o valor chega como string
// e o Fastify converte pra número sozinho (útil na paginação).
export const app = fastify({
  ajv: {
    customOptions: {
      coerceTypes: true,
    },
  },
})

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
      { name: 'usuarios', description: 'Gestão de usuários' },
      { name: 'unidades', description: 'Unidades da rede' },
      { name: 'produtos', description: 'Produtos do cardápio' },
      { name: 'estoque', description: 'Estoque por unidade' },
      {
        name: 'movimentacoes-estoque',
        description: 'Movimentações de estoque',
      },
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

// Todas as rotas da API ficam sob /v1 (versionamento).
async function registerV1Routes(instance: FastifyInstance) {
  await instance.register(authRoutes, { prefix: '/auth' })
  await instance.register(helloRoutes)
  await instance.register(usersRoutes)
  await instance.register(unidadesRoutes)
  await instance.register(produtosRoutes)
  await instance.register(estoqueRoutes)
  await instance.register(movimentacoesEstoqueRoutes)
}

app.register(registerV1Routes, { prefix: '/v1' })

app.register(swaggerUi, {
  routePrefix: '/documentation',
})
