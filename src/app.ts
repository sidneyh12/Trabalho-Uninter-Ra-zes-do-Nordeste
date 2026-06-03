import fastify from 'fastify'
import cookie from '@fastify/cookie'

import { helloRoutes } from './routes/hello.js'

export const app = fastify()

// cookies
app.register(cookie)

// Rotas para transações
app.register(helloRoutes, {
  prefix: 'hello',
})
