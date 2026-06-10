import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { db } from '../database.js'
import {
  forbiddenError,
  invalidPayloadError,
  invalidUserCreationPayloadError,
  invalidUserUpdatePayloadError,
} from '../http/errors.js'
import { authenticate } from '../middlewares/authenticate.js'
import {
  AcaoAuditoria,
  getUsuarioIdFromRequest,
  registrarLogAuditoria,
} from '../services/audit-log.js'
import { hashPassword } from '../utils/password.js'

// CRUD de usuários — só quem tem perfil ADMIN pode mexer aqui.
// A senha nunca volta na resposta; no banco fica só o hash.

const errorResponseSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    message: { type: 'string' },
  },
  required: ['error', 'message'],
} as const

export async function usersRoutes(app: FastifyInstance) {
  // GET /usuarios — lista com paginação (page e limit na query string)
  app.get(
    '/usuarios',
    {
      // authenticate roda ANTES do handler — sem token válido nem chega aqui
      preHandler: [authenticate],
      attachValidation: true,
      schema: {
        tags: ['usuarios'],
        summary: 'Listar usuarios (somente ADMIN)',
        description:
          '**Somente perfil ADMIN.** Gestão de contas da rede; GERENTE e demais perfis recebem 403.',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            page: {
              type: 'integer',
              minimum: 1,
              default: 1,
              description: 'Numero da pagina (comeca em 1)',
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 100,
              default: 10,
              description: 'Quantidade de registros por pagina (maximo 100)',
            },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['data', 'page', 'limit', 'total'],
            properties: {
              data: {
                type: 'array',
                items: {
                  type: 'object',
                  required: [
                    'id',
                    'nome',
                    'email',
                    'perfil',
                    'data_nascimento',
                    'unidade_vinculada_id',
                    'criado_em',
                  ],
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    nome: { type: 'string' },
                    email: { type: 'string', format: 'email' },
                    perfil: { type: 'string' },
                    data_nascimento: {
                      type: ['string', 'null'],
                      format: 'date',
                    },
                    unidade_vinculada_id: {
                      type: ['string', 'null'],
                      format: 'uuid',
                    },
                    criado_em: { type: 'string', format: 'date-time' },
                  },
                },
              },
              page: { type: 'integer' },
              limit: { type: 'integer' },
              total: { type: 'integer' },
            },
          },
          400: { description: 'Parametros invalidos', ...errorResponseSchema },
          401: {
            description: 'Token invalido/ausente',
            ...errorResponseSchema,
          },
          403: { description: 'Perfil sem permissao', ...errorResponseSchema },
        },
      },
    },
    async (request, reply) => {
      if (request.validationError) {
        return reply.status(400).send({
          error: 'DADOS_INVALIDOS',
          message:
            'Parametros de paginacao invalidos. Use page >= 1 e limit entre 1 e 100 (ex.: ?page=1&limit=10).',
        })
      }

      // Checa se quem chamou a rota é ADMIN (veio no JWT no login)
      const authUser = request.user as { perfil?: string } | undefined
      if (authUser?.perfil !== 'ADMIN') {
        return reply.status(403).send(forbiddenError())
      }

      // Paginação: page 1 = primeiros registros, offset pula os anteriores
      const q = request.query as { page?: number; limit?: number }
      const page = typeof q.page === 'number' && q.page >= 1 ? q.page : 1
      let limit = typeof q.limit === 'number' && q.limit >= 1 ? q.limit : 10
      if (limit > 100) limit = 100
      const offset = (page - 1) * limit

      const [countRow] = await db('usuarios').count('* as total')
      const total = Number((countRow as { total: string }).total ?? 0)

      const data = await db('usuarios')
        .select(
          'id',
          'nome',
          'email',
          'perfil',
          'data_nascimento',
          'unidade_vinculada_id',
          'criado_em',
        )
        .orderBy('criado_em', 'desc')
        .limit(limit)
        .offset(offset)

      return reply.status(200).send({ data, page, limit, total })
    },
  )

  // POST /usuarios — cadastro de nova conta
  app.post(
    '/usuarios',
    {
      preHandler: [authenticate],
      attachValidation: true,
      schema: {
        tags: ['usuarios'],
        summary: 'Criar usuario (somente ADMIN)',
        description:
          '**Somente perfil ADMIN.** Cria contas (inclui GERENTE, COZINHA, etc.).',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['nome', 'email', 'senha', 'perfil'],
          properties: {
            nome: { type: 'string', minLength: 1 },
            email: { type: 'string', format: 'email' },
            senha: { type: 'string', minLength: 6 },
            perfil: {
              type: 'string',
              enum: ['ADMIN', 'GERENTE', 'CLIENTE', 'COZINHA', 'BALCAO'],
            },
            data_nascimento: { type: 'string', format: 'date' },
            unidade_vinculada_id: {
              type: 'string',
              format: 'uuid',
              description:
                'Obrigatorio para COZINHA e BALCAO (fila de pedidos da unidade)',
            },
          },
        },
        response: {
          201: {
            type: 'object',
            required: [
              'id',
              'nome',
              'email',
              'perfil',
              'data_nascimento',
              'unidade_vinculada_id',
              'criado_em',
            ],
            properties: {
              id: { type: 'string', format: 'uuid' },
              nome: { type: 'string' },
              email: { type: 'string', format: 'email' },
              perfil: { type: 'string' },
              data_nascimento: { type: ['string', 'null'], format: 'date' },
              unidade_vinculada_id: {
                type: ['string', 'null'],
                format: 'uuid',
              },
              criado_em: { type: 'string', format: 'date-time' },
            },
          },
          400: { description: 'Payload invalido', ...errorResponseSchema },
          401: {
            description: 'Token invalido/ausente',
            ...errorResponseSchema,
          },
          403: { description: 'Perfil sem permissao', ...errorResponseSchema },
          404: {
            description: 'Unidade vinculada inexistente',
            ...errorResponseSchema,
          },
          409: { description: 'Email ja cadastrado', ...errorResponseSchema },
        },
      },
    },
    async (request, reply) => {
      if (request.validationError) {
        return reply.status(400).send(invalidUserCreationPayloadError())
      }

      const authUser = request.user as { perfil?: string } | undefined
      if (authUser?.perfil !== 'ADMIN') {
        return reply.status(403).send(forbiddenError())
      }

      const bodySchema = z
        .object({
          nome: z.string().trim().min(1),
          email: z.string().trim().email(),
          senha: z.string().min(6),
          perfil: z.enum(['ADMIN', 'GERENTE', 'CLIENTE', 'COZINHA', 'BALCAO']),
          data_nascimento: z.string().date().optional(),
          unidade_vinculada_id: z.string().uuid().optional(),
        })
        // COZINHA e BALCAO precisam estar ligados a uma unidade (regra do trabalho)
        .superRefine((data, ctx) => {
          if (
            (data.perfil === 'COZINHA' || data.perfil === 'BALCAO') &&
            data.unidade_vinculada_id === undefined
          ) {
            ctx.addIssue({
              code: 'custom',
              message:
                'unidade_vinculada_id e obrigatorio para perfil COZINHA ou BALCAO.',
            })
          }
        })

      const parsedBody = bodySchema.safeParse(request.body)
      if (!parsedBody.success) {
        return reply.status(400).send(invalidPayloadError())
      }

      const {
        nome,
        email,
        senha,
        perfil,
        data_nascimento,
        unidade_vinculada_id,
      } = parsedBody.data

      if (unidade_vinculada_id) {
        const uni = await db('unidades')
          .select('id')
          .where({ id: unidade_vinculada_id })
          .first()
        if (!uni) {
          return reply.status(404).send({
            error: 'NAO_ENCONTRADO',
            message: 'Unidade vinculada nao encontrada.',
          })
        }
      }

      const existingUser = await db('usuarios').where({ email }).first()
      if (existingUser) {
        return reply.status(409).send({
          error: 'CONFLITO',
          message: 'Email ja cadastrado.',
        })
      }

      const id = randomUUID()
      // Hash da senha — nunca salvar senha em texto puro no banco!
      const senha_hash = hashPassword(senha)

      await db('usuarios').insert({
        id,
        nome,
        email,
        senha_hash,
        perfil,
        data_nascimento: data_nascimento ?? null,
        unidade_vinculada_id: unidade_vinculada_id ?? null,
        criado_em: db.fn.now(),
      })

      const createdUser = await db('usuarios')
        .select(
          'id',
          'nome',
          'email',
          'perfil',
          'data_nascimento',
          'unidade_vinculada_id',
          'criado_em',
        )
        .where({ id })
        .first()

      const actorId = getUsuarioIdFromRequest(request)
      if (actorId) {
        await registrarLogAuditoria(request.log, {
          usuarioId: actorId,
          acao: AcaoAuditoria.USUARIO_CREATE,
          detalhes: JSON.stringify({ novo_usuario_id: id, email, perfil }),
          ipOrigem: request.ip,
        })
      }

      return reply.status(201).send(createdUser)
    },
  )

  // PUT /usuarios/:id — atualiza só os campos que vierem no body
  app.put(
    '/usuarios/:id',
    {
      preHandler: [authenticate],
      attachValidation: true,
      schema: {
        tags: ['usuarios'],
        summary: 'Atualizar usuario (somente ADMIN)',
        description: '**Somente perfil ADMIN.**',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
        body: {
          type: 'object',
          properties: {
            nome: { type: 'string', minLength: 1 },
            email: { type: 'string', format: 'email' },
            senha: { type: 'string', minLength: 6 },
            perfil: {
              type: 'string',
              enum: ['ADMIN', 'GERENTE', 'CLIENTE', 'COZINHA', 'BALCAO'],
            },
            data_nascimento: { type: 'string', format: 'date' },
            unidade_vinculada_id: {
              type: ['string', 'null'],
              format: 'uuid',
            },
          },
          minProperties: 1,
        },
        response: {
          200: {
            type: 'object',
            required: [
              'id',
              'nome',
              'email',
              'perfil',
              'data_nascimento',
              'unidade_vinculada_id',
              'criado_em',
            ],
            properties: {
              id: { type: 'string', format: 'uuid' },
              nome: { type: 'string' },
              email: { type: 'string', format: 'email' },
              perfil: { type: 'string' },
              data_nascimento: { type: ['string', 'null'], format: 'date' },
              unidade_vinculada_id: {
                type: ['string', 'null'],
                format: 'uuid',
              },
              criado_em: { type: 'string', format: 'date-time' },
            },
          },
          400: { description: 'Payload invalido', ...errorResponseSchema },
          401: {
            description: 'Token invalido/ausente',
            ...errorResponseSchema,
          },
          403: { description: 'Perfil sem permissao', ...errorResponseSchema },
          404: {
            description: 'Usuario nao encontrado',
            ...errorResponseSchema,
          },
          409: { description: 'Email ja cadastrado', ...errorResponseSchema },
        },
      },
    },
    async (request, reply) => {
      if (request.validationError) {
        return reply.status(400).send({
          error: 'DADOS_INVALIDOS',
          message:
            'Dados de atualizacao invalidos. Informe ao menos um campo valido para atualizar.',
        })
      }

      const authUser = request.user as { perfil?: string } | undefined
      if (authUser?.perfil !== 'ADMIN') {
        return reply.status(403).send(forbiddenError())
      }

      const paramsSchema = z.object({
        id: z.string().uuid(),
      })

      const bodySchema = z
        .object({
          nome: z.string().trim().min(1).optional(),
          email: z.string().trim().email().optional(),
          senha: z.string().min(6).optional(),
          perfil: z
            .enum(['ADMIN', 'GERENTE', 'CLIENTE', 'COZINHA', 'BALCAO'])
            .optional(),
          data_nascimento: z.string().date().optional(),
          unidade_vinculada_id: z
            .union([z.string().uuid(), z.null()])
            .optional(),
        })
        .refine((data) => Object.keys(data).length > 0)

      const parsedParams = paramsSchema.safeParse(request.params)
      const parsedBody = bodySchema.safeParse(request.body)

      if (!parsedParams.success) {
        return reply.status(400).send({
          error: 'DADOS_INVALIDOS',
          message: 'O id na URL deve ser um UUID valido.',
        })
      }

      if (!parsedBody.success) {
        return reply.status(400).send(invalidUserUpdatePayloadError())
      }

      const { id } = parsedParams.data
      const {
        nome,
        email,
        senha,
        perfil,
        data_nascimento,
        unidade_vinculada_id,
      } = parsedBody.data

      const targetUser = await db('usuarios').where({ id }).first()
      if (!targetUser) {
        return reply.status(404).send({
          error: 'NAO_ENCONTRADO',
          message: 'Usuario nao encontrado.',
        })
      }

      if (email) {
        const userWithSameEmail = await db('usuarios')
          .where({ email })
          .whereNot({ id })
          .first()

        if (userWithSameEmail) {
          return reply.status(409).send({
            error: 'CONFLITO',
            message: 'Email ja cadastrado.',
          })
        }
      }

      if (unidade_vinculada_id !== undefined && unidade_vinculada_id !== null) {
        const uni = await db('unidades')
          .select('id')
          .where({ id: unidade_vinculada_id })
          .first()
        if (!uni) {
          return reply.status(404).send({
            error: 'NAO_ENCONTRADO',
            message: 'Unidade vinculada nao encontrada.',
          })
        }
      }

      const effectivePerfil =
        perfil ?? String((targetUser as { perfil: string }).perfil)
      const effectiveUnidade =
        unidade_vinculada_id !== undefined
          ? unidade_vinculada_id
          : ((targetUser as { unidade_vinculada_id?: string | null })
              .unidade_vinculada_id ?? null)

      if (
        (effectivePerfil === 'COZINHA' || effectivePerfil === 'BALCAO') &&
        (effectiveUnidade === null || effectiveUnidade === '')
      ) {
        return reply.status(400).send({
          error: 'DADOS_INVALIDOS',
          message:
            'Perfil COZINHA ou BALCAO exige unidade_vinculada_id cadastrada.',
        })
      }

      const patch: Record<string, unknown> = {}
      if (nome !== undefined) patch.nome = nome
      if (email !== undefined) patch.email = email
      if (perfil !== undefined) patch.perfil = perfil
      if (data_nascimento !== undefined) patch.data_nascimento = data_nascimento
      if (senha !== undefined) patch.senha_hash = hashPassword(senha)
      if (unidade_vinculada_id !== undefined) {
        patch.unidade_vinculada_id = unidade_vinculada_id
      }

      await db('usuarios').where({ id }).update(patch)

      const updatedUser = await db('usuarios')
        .select(
          'id',
          'nome',
          'email',
          'perfil',
          'data_nascimento',
          'unidade_vinculada_id',
          'criado_em',
        )
        .where({ id })
        .first()

      const actorId = getUsuarioIdFromRequest(request)
      if (actorId) {
        await registrarLogAuditoria(request.log, {
          usuarioId: actorId,
          acao: AcaoAuditoria.USUARIO_UPDATE,
          detalhes: JSON.stringify({
            usuario_alvo_id: id,
            campos: Object.keys(patch),
          }),
          ipOrigem: request.ip,
        })
      }

      return reply.status(200).send(updatedUser)
    },
  )

  // DELETE /usuarios/:id — remove e devolve 204 (sem corpo na resposta)
  app.delete(
    '/usuarios/:id',
    {
      preHandler: [authenticate],
      attachValidation: true,
      schema: {
        tags: ['usuarios'],
        summary: 'Remover usuario (somente ADMIN)',
        description: '**Somente perfil ADMIN.**',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
        response: {
          204: { description: 'Usuario removido' },
          400: { description: 'Id invalido', ...errorResponseSchema },
          401: {
            description: 'Token invalido/ausente',
            ...errorResponseSchema,
          },
          403: { description: 'Perfil sem permissao', ...errorResponseSchema },
          404: {
            description: 'Usuario nao encontrado',
            ...errorResponseSchema,
          },
        },
      },
    },
    async (request, reply) => {
      if (request.validationError) {
        return reply.status(400).send({
          error: 'DADOS_INVALIDOS',
          message: 'O id na URL deve ser um UUID valido.',
        })
      }

      const authUser = request.user as { perfil?: string } | undefined
      if (authUser?.perfil !== 'ADMIN') {
        return reply.status(403).send(forbiddenError())
      }

      const paramsSchema = z.object({
        id: z.string().uuid(),
      })

      const parsedParams = paramsSchema.safeParse(request.params)
      if (!parsedParams.success) {
        return reply.status(400).send({
          error: 'DADOS_INVALIDOS',
          message: 'O id na URL deve ser um UUID valido.',
        })
      }

      const { id } = parsedParams.data

      const deleted = await db('usuarios').where({ id }).del()
      if (deleted === 0) {
        return reply.status(404).send({
          error: 'NAO_ENCONTRADO',
          message: 'Usuario nao encontrado.',
        })
      }

      const actorId = getUsuarioIdFromRequest(request)
      if (actorId) {
        await registrarLogAuditoria(request.log, {
          usuarioId: actorId,
          acao: AcaoAuditoria.USUARIO_DELETE,
          detalhes: JSON.stringify({ usuario_removido_id: id }),
          ipOrigem: request.ip,
        })
      }

      return reply.status(204).send()
    },
  )
}
