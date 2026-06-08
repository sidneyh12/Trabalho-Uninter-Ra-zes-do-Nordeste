import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { db } from '../database.js'
import { invalidCredentialsError, invalidPayloadError } from '../http/errors.js'
import { AcaoAuditoria, registrarLogAuditoria } from '../services/audit-log.js'
import { verifyPassword } from '../utils/password.js'

const errorResponseSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    message: { type: 'string' },
  },
  required: ['error', 'message'],
} as const

export async function authRoutes(app: FastifyInstance) {
  app.post(
    '/login',
    {
      schema: {
        tags: ['auth'],
        summary: 'Login',
        description:
          'Autentica com email e senha e retorna um JWT (Bearer) e dados públicos do usuário.',
        body: {
          type: 'object',
          required: ['email', 'senha'],
          properties: {
            email: { type: 'string', format: 'email' },
            senha: { type: 'string', minLength: 1 },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['accessToken', 'tokenType', 'expiresIn', 'user'],
            properties: {
              accessToken: { type: 'string' },
              tokenType: { type: 'string', example: 'Bearer' },
              expiresIn: { type: 'integer', example: 3600 },
              user: {
                type: 'object',
                required: ['id', 'nome', 'email', 'perfil'],
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  nome: { type: 'string' },
                  email: { type: 'string', format: 'email' },
                  perfil: { type: 'string' },
                },
              },
            },
          },
          400: { description: 'Payload inválido', ...errorResponseSchema },
          401: { description: 'Credenciais inválidas', ...errorResponseSchema },
        },
      },
    },
    async (request, reply) => {
      const bodySchema = z.object({
        email: z.string().email(),
        senha: z.string().min(1),
      })

      const parsedBody = bodySchema.safeParse(request.body)

      if (!parsedBody.success) {
        return reply.status(400).send(invalidPayloadError())
      }

      const { email, senha } = parsedBody.data

      const user = await db('usuarios')
        .select('id', 'nome', 'email', 'senha_hash', 'perfil')
        .where({ email })
        .first()

      if (!user || !verifyPassword(senha, user.senha_hash)) {
        return reply.status(401).send(invalidCredentialsError())
      }

      const accessToken = await reply.jwtSign(
        { sub: user.id, perfil: user.perfil },
        { expiresIn: '1h' },
      )

      await registrarLogAuditoria(request.log, {
        usuarioId: user.id,
        acao: AcaoAuditoria.AUTH_LOGIN,
        detalhes: JSON.stringify({ usuario_id: user.id, perfil: user.perfil }),
        ipOrigem: request.ip,
      })

      return reply.status(200).send({
        accessToken,
        tokenType: 'Bearer',
        expiresIn: 3600,
        user: {
          id: user.id,
          nome: user.nome,
          email: user.email,
          perfil: user.perfil,
        },
      })
    },
  )
}
