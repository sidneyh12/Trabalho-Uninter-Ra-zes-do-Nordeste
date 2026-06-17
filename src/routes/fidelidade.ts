import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { isAdminOuGerente, isPerfilAdmin } from '../authz/perfis.js'
import { db } from '../database.js'
import {
  forbiddenError,
  invalidFidelidadeCreationPayloadError,
  invalidFidelidadeUpdatePayloadError,
} from '../http/errors.js'
import { authenticate } from '../middlewares/authenticate.js'
import {
  AcaoAuditoria,
  getUsuarioIdFromRequest,
  registrarLogAuditoria,
} from '../services/audit-log.js'

// Programa de fidelidade — pontos por cliente + consentimento LGPD.
// Um registro por cliente (UNIQUE em cliente_id na migration).

const errorResponseSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    message: { type: 'string' },
  },
  required: ['error', 'message'],
} as const

const fidelidadeResponseProps = {
  type: 'object',
  required: [
    'id',
    'cliente_id',
    'saldo_pontos',
    'consentimento_explicitado',
    'data_consentimento',
    'ultima_atualizacao',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    cliente_id: { type: 'string', format: 'uuid' },
    saldo_pontos: { type: 'integer' },
    consentimento_explicitado: { type: 'boolean' },
    data_consentimento: { type: ['string', 'null'], format: 'date-time' },
    ultima_atualizacao: { type: 'string', format: 'date-time' },
  },
} as const

function getSub(request: { user?: unknown }): string | undefined {
  return (request.user as { sub?: string } | undefined)?.sub
}

function serializeFidelidade(row: Record<string, unknown>) {
  return {
    id: row.id,
    cliente_id: row.cliente_id,
    saldo_pontos: Number(row.saldo_pontos),
    consentimento_explicitado: Boolean(row.consentimento_explicitado),
    data_consentimento:
      row.data_consentimento instanceof Date
        ? row.data_consentimento.toISOString()
        : row.data_consentimento
          ? String(row.data_consentimento)
          : null,
    ultima_atualizacao:
      row.ultima_atualizacao instanceof Date
        ? row.ultima_atualizacao.toISOString()
        : String(row.ultima_atualizacao),
  }
}

export async function fidelidadeRoutes(app: FastifyInstance) {
  app.get(
    '/fidelidade',
    {
      preHandler: [authenticate],
      attachValidation: true,
      schema: {
        tags: ['fidelidade'],
        summary: 'Listar registros de fidelidade',
        description:
          'ADMIN/GERENTE veem todos. CLIENTE ve apenas o proprio registro.',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
            cliente_id: { type: 'string', format: 'uuid' },
            consentimento_explicitado: { type: 'boolean' },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['data', 'page', 'limit', 'total'],
            properties: {
              data: { type: 'array', items: fidelidadeResponseProps },
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
          403: { description: 'Sem permissao', ...errorResponseSchema },
        },
      },
    },
    async (request, reply) => {
      if (request.validationError) {
        return reply.status(400).send({
          error: 'DADOS_INVALIDOS',
          message: 'Parametros invalidos. Use page >= 1 e limit entre 1 e 100.',
        })
      }

      const sub = getSub(request)
      if (!sub) {
        return reply.status(401).send({
          error: 'NAO_AUTORIZADO',
          message: 'Token invalido.',
        })
      }

      const q = request.query as {
        page?: number
        limit?: number
        cliente_id?: string
        consentimento_explicitado?: boolean
      }

      const page = typeof q.page === 'number' && q.page >= 1 ? q.page : 1
      let limit = typeof q.limit === 'number' && q.limit >= 1 ? q.limit : 10
      if (limit > 100) limit = 100
      const offset = (page - 1) * limit

      let countQuery = db('fidelidade')
      let listQuery = db('fidelidade')
        .select(
          'id',
          'cliente_id',
          'saldo_pontos',
          'consentimento_explicitado',
          'data_consentimento',
          'ultima_atualizacao',
        )
        .orderBy('ultima_atualizacao', 'desc')

      if (!isAdminOuGerente(request)) {
        countQuery = countQuery.where({ cliente_id: sub })
        listQuery = listQuery.where({ cliente_id: sub })
        if (q.cliente_id && q.cliente_id !== sub) {
          return reply.status(403).send(forbiddenError())
        }
      } else if (q.cliente_id) {
        countQuery = countQuery.where({ cliente_id: q.cliente_id })
        listQuery = listQuery.where({ cliente_id: q.cliente_id })
      }

      if (typeof q.consentimento_explicitado === 'boolean') {
        countQuery = countQuery.where({
          consentimento_explicitado: q.consentimento_explicitado,
        })
        listQuery = listQuery.where({
          consentimento_explicitado: q.consentimento_explicitado,
        })
      }

      const [countRow] = await countQuery.count('* as total')
      const total = Number((countRow as { total: string }).total ?? 0)
      const rows = await listQuery.limit(limit).offset(offset)

      return reply.status(200).send({
        data: rows.map((r) =>
          serializeFidelidade(r as Record<string, unknown>),
        ),
        page,
        limit,
        total,
      })
    },
  )

  app.get(
    '/fidelidade/:id',
    {
      preHandler: [authenticate],
      attachValidation: true,
      schema: {
        tags: ['fidelidade'],
        summary: 'Buscar fidelidade por id',
        description: 'CLIENTE so pode acessar o proprio registro.',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: {
          200: fidelidadeResponseProps,
          400: { description: 'Id invalido', ...errorResponseSchema },
          401: {
            description: 'Token invalido/ausente',
            ...errorResponseSchema,
          },
          403: { description: 'Sem permissao', ...errorResponseSchema },
          404: {
            description: 'Registro nao encontrado',
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

      const sub = getSub(request)
      if (!sub) {
        return reply.status(401).send({
          error: 'NAO_AUTORIZADO',
          message: 'Token invalido.',
        })
      }

      const paramsSchema = z.object({ id: z.string().uuid() })
      const parsed = paramsSchema.safeParse(request.params)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'DADOS_INVALIDOS',
          message: 'O id na URL deve ser um UUID valido.',
        })
      }

      const row = await db('fidelidade').where({ id: parsed.data.id }).first()

      if (!row) {
        return reply.status(404).send({
          error: 'NAO_ENCONTRADO',
          message: 'Fidelidade nao encontrada.',
        })
      }

      if (!isAdminOuGerente(request) && String(row.cliente_id) !== sub) {
        return reply.status(403).send(forbiddenError())
      }

      return reply
        .status(200)
        .send(serializeFidelidade(row as Record<string, unknown>))
    },
  )

  app.post(
    '/fidelidade',
    {
      preHandler: [authenticate],
      attachValidation: true,
      schema: {
        tags: ['fidelidade'],
        summary: 'Criar registro de fidelidade (ADMIN ou GERENTE)',
        description:
          'Cria o cadastro de fidelidade para um cliente (um registro por cliente).',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['cliente_id'],
          properties: {
            cliente_id: { type: 'string', format: 'uuid' },
            saldo_pontos: { type: 'integer', minimum: 0 },
            consentimento_explicitado: { type: 'boolean' },
            data_consentimento: { type: 'string', format: 'date-time' },
          },
        },
        response: {
          201: fidelidadeResponseProps,
          400: { description: 'Payload invalido', ...errorResponseSchema },
          401: {
            description: 'Token invalido/ausente',
            ...errorResponseSchema,
          },
          403: { description: 'Sem permissao', ...errorResponseSchema },
          404: {
            description: 'Cliente nao encontrado',
            ...errorResponseSchema,
          },
          409: {
            description: 'Cliente ja cadastrado na fidelidade',
            ...errorResponseSchema,
          },
        },
      },
    },
    async (request, reply) => {
      if (request.validationError) {
        return reply.status(400).send(invalidFidelidadeCreationPayloadError())
      }
      if (!isAdminOuGerente(request)) {
        return reply.status(403).send(forbiddenError())
      }

      const bodySchema = z.object({
        cliente_id: z.string().uuid(),
        saldo_pontos: z.number().int().min(0).optional(),
        consentimento_explicitado: z.boolean().optional(),
        data_consentimento: z.string().datetime().optional(),
      })
      const parsedBody = bodySchema.safeParse(request.body)
      if (!parsedBody.success) {
        return reply.status(400).send(invalidFidelidadeCreationPayloadError())
      }

      const cliente = await db('usuarios')
        .select('id')
        .where({ id: parsedBody.data.cliente_id })
        .first()
      if (!cliente) {
        return reply.status(404).send({
          error: 'NAO_ENCONTRADO',
          message: 'Cliente nao encontrado.',
        })
      }

      const existing = await db('fidelidade')
        .where({ cliente_id: parsedBody.data.cliente_id })
        .first()
      if (existing) {
        return reply.status(409).send({
          error: 'CONFLITO',
          message: 'Este cliente ja possui registro de fidelidade.',
        })
      }

      const id = randomUUID()
      const consent = parsedBody.data.consentimento_explicitado ?? false
      const dataConsent = consent
        ? (parsedBody.data.data_consentimento ?? new Date().toISOString())
        : null

      await db('fidelidade').insert({
        id,
        cliente_id: parsedBody.data.cliente_id,
        saldo_pontos: parsedBody.data.saldo_pontos ?? 0,
        consentimento_explicitado: consent,
        data_consentimento: dataConsent,
        ultima_atualizacao: db.fn.now(),
      })

      const created = await db('fidelidade').where({ id }).first()

      const actorId = getUsuarioIdFromRequest(request)
      if (actorId) {
        await registrarLogAuditoria(request.log, {
          usuarioId: actorId,
          acao: AcaoAuditoria.FIDELIDADE_CREATE,
          detalhes: JSON.stringify({
            fidelidade_id: id,
            cliente_id: parsedBody.data.cliente_id,
          }),
          ipOrigem: request.ip,
        })
      }

      return reply
        .status(201)
        .send(serializeFidelidade(created as Record<string, unknown>))
    },
  )

  app.put(
    '/fidelidade/:id',
    {
      preHandler: [authenticate],
      attachValidation: true,
      schema: {
        tags: ['fidelidade'],
        summary: 'Atualizar fidelidade (ADMIN ou GERENTE)',
        description:
          'Atualiza saldo e consentimento; ajuste_pontos_delta credita ou debita pontos.',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          properties: {
            saldo_pontos: { type: 'integer', minimum: 0 },
            ajuste_pontos_delta: { type: 'integer' },
            consentimento_explicitado: { type: 'boolean' },
            data_consentimento: {
              type: ['string', 'null'],
              format: 'date-time',
            },
          },
          minProperties: 1,
        },
        response: {
          200: fidelidadeResponseProps,
          400: { description: 'Payload invalido', ...errorResponseSchema },
          401: {
            description: 'Token invalido/ausente',
            ...errorResponseSchema,
          },
          403: { description: 'Sem permissao', ...errorResponseSchema },
          404: {
            description: 'Registro nao encontrado',
            ...errorResponseSchema,
          },
          409: { description: 'Conflito de saldo', ...errorResponseSchema },
        },
      },
    },
    async (request, reply) => {
      if (request.validationError) {
        return reply.status(400).send(invalidFidelidadeUpdatePayloadError())
      }
      if (!isAdminOuGerente(request)) {
        return reply.status(403).send(forbiddenError())
      }

      const paramsSchema = z.object({ id: z.string().uuid() })
      const bodySchema = z
        .object({
          saldo_pontos: z.number().int().min(0).optional(),
          ajuste_pontos_delta: z.number().int().optional(),
          consentimento_explicitado: z.boolean().optional(),
          data_consentimento: z
            .union([z.string().datetime(), z.null()])
            .optional(),
        })
        .refine(
          (d) =>
            d.saldo_pontos !== undefined ||
            d.ajuste_pontos_delta !== undefined ||
            d.consentimento_explicitado !== undefined ||
            d.data_consentimento !== undefined,
        )

      const parsedParams = paramsSchema.safeParse(request.params)
      const parsedBody = bodySchema.safeParse(request.body)
      if (!parsedParams.success) {
        return reply.status(400).send({
          error: 'DADOS_INVALIDOS',
          message: 'O id na URL deve ser um UUID valido.',
        })
      }
      if (!parsedBody.success) {
        return reply.status(400).send(invalidFidelidadeUpdatePayloadError())
      }

      const row = await db('fidelidade')
        .where({ id: parsedParams.data.id })
        .first()
      if (!row) {
        return reply.status(404).send({
          error: 'NAO_ENCONTRADO',
          message: 'Fidelidade nao encontrada.',
        })
      }

      const patch: Record<string, unknown> = {}
      const saldoAtual = Number(row.saldo_pontos)
      let saldoFinal = saldoAtual

      if (parsedBody.data.saldo_pontos !== undefined) {
        saldoFinal = parsedBody.data.saldo_pontos
      }
      if (parsedBody.data.ajuste_pontos_delta !== undefined) {
        saldoFinal += parsedBody.data.ajuste_pontos_delta
      }
      if (saldoFinal < 0) {
        return reply.status(409).send({
          error: 'CONFLITO',
          message: 'Saldo de pontos nao pode ficar negativo.',
        })
      }
      patch.saldo_pontos = saldoFinal

      if (parsedBody.data.consentimento_explicitado !== undefined) {
        patch.consentimento_explicitado =
          parsedBody.data.consentimento_explicitado
        if (parsedBody.data.consentimento_explicitado === false) {
          patch.data_consentimento = null
        } else if (
          parsedBody.data.data_consentimento === undefined &&
          !row.data_consentimento
        ) {
          patch.data_consentimento = new Date().toISOString()
        }
      }
      if (parsedBody.data.data_consentimento !== undefined) {
        patch.data_consentimento = parsedBody.data.data_consentimento
      }

      patch.ultima_atualizacao = db.fn.now()

      await db('fidelidade').where({ id: parsedParams.data.id }).update(patch)
      const updated = await db('fidelidade')
        .where({ id: parsedParams.data.id })
        .first()

      const actorId = getUsuarioIdFromRequest(request)
      if (actorId) {
        await registrarLogAuditoria(request.log, {
          usuarioId: actorId,
          acao: AcaoAuditoria.FIDELIDADE_UPDATE,
          detalhes: JSON.stringify({
            fidelidade_id: parsedParams.data.id,
            campos: Object.keys(patch),
          }),
          ipOrigem: request.ip,
        })
      }

      return reply
        .status(200)
        .send(serializeFidelidade(updated as Record<string, unknown>))
    },
  )

  app.delete(
    '/fidelidade/:id',
    {
      preHandler: [authenticate],
      attachValidation: true,
      schema: {
        tags: ['fidelidade'],
        summary: 'Remover fidelidade (somente ADMIN)',
        description: 'Exclusao fisica do registro de fidelidade.',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: {
          204: { description: 'Registro removido' },
          400: { description: 'Id invalido', ...errorResponseSchema },
          401: {
            description: 'Token invalido/ausente',
            ...errorResponseSchema,
          },
          403: { description: 'Sem permissao', ...errorResponseSchema },
          404: {
            description: 'Registro nao encontrado',
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
      if (!isPerfilAdmin(request)) {
        return reply.status(403).send(forbiddenError())
      }

      const paramsSchema = z.object({ id: z.string().uuid() })
      const parsed = paramsSchema.safeParse(request.params)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'DADOS_INVALIDOS',
          message: 'O id na URL deve ser um UUID valido.',
        })
      }

      const deleted = await db('fidelidade').where({ id: parsed.data.id }).del()
      if (deleted === 0) {
        return reply.status(404).send({
          error: 'NAO_ENCONTRADO',
          message: 'Fidelidade nao encontrada.',
        })
      }

      const actorId = getUsuarioIdFromRequest(request)
      if (actorId) {
        await registrarLogAuditoria(request.log, {
          usuarioId: actorId,
          acao: AcaoAuditoria.FIDELIDADE_DELETE,
          detalhes: JSON.stringify({ fidelidade_id: parsed.data.id }),
          ipOrigem: request.ip,
        })
      }

      return reply.status(204).send()
    },
  )
}
