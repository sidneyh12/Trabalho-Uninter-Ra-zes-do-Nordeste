import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { isAdminOuGerente } from '../authz/perfis.js'
import { db } from '../database.js'
import { forbiddenError } from '../http/errors.js'
import { authenticate } from '../middlewares/authenticate.js'

// Leitura da trilha de auditoria — logs são gravados nas mutações, não há POST aqui.

const errorResponseSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    message: { type: 'string' },
  },
  required: ['error', 'message'],
} as const

const logAuditoriaItemSchema = {
  type: 'object',
  required: [
    'id',
    'usuario_id',
    'usuario_nome',
    'usuario_email',
    'acao',
    'detalhes',
    'ip_origem',
    'timestamp',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    usuario_id: { type: 'string', format: 'uuid' },
    usuario_nome: { type: ['string', 'null'] },
    usuario_email: { type: ['string', 'null'] },
    acao: { type: 'string' },
    detalhes: { type: ['string', 'null'] },
    ip_origem: { type: ['string', 'null'] },
    timestamp: { type: 'string', format: 'date-time' },
  },
} as const

function serializeRow(row: Record<string, unknown>) {
  const ts = row.timestamp
  return {
    id: row.id,
    usuario_id: row.usuario_id,
    usuario_nome: row.usuario_nome ? String(row.usuario_nome) : null,
    usuario_email: row.usuario_email ? String(row.usuario_email) : null,
    acao: String(row.acao),
    detalhes: row.detalhes == null ? null : String(row.detalhes),
    ip_origem: row.ip_origem == null ? null : String(row.ip_origem),
    timestamp: ts instanceof Date ? ts.toISOString() : String(ts),
  }
}

export async function logsAuditoriaRoutes(app: FastifyInstance) {
  app.get(
    '/logs-auditoria',
    {
      preHandler: [authenticate],
      attachValidation: true,
      schema: {
        tags: ['logs-auditoria'],
        summary: 'Listar logs de auditoria (ADMIN ou GERENTE)',
        description:
          'Somente ADMIN ou GERENTE. Consulta paginada com filtros. Sem endpoint de escrita.',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
            usuario_id: { type: 'string', format: 'uuid' },
            acao: { type: 'string', minLength: 1 },
            desde: { type: 'string', format: 'date-time' },
            ate: { type: 'string', format: 'date-time' },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['data', 'page', 'limit', 'total'],
            properties: {
              data: { type: 'array', items: logAuditoriaItemSchema },
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

      if (!isAdminOuGerente(request)) {
        return reply.status(403).send(forbiddenError())
      }

      const qSchema = z.object({
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(10),
        usuario_id: z.string().uuid().optional(),
        acao: z.string().trim().min(1).optional(),
        desde: z.string().datetime().optional(),
        ate: z.string().datetime().optional(),
      })

      const parsed = qSchema.safeParse(request.query)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'DADOS_INVALIDOS',
          message: 'Parametros de filtro invalidos.',
        })
      }

      const { page, limit, usuario_id, acao, desde, ate } = parsed.data
      if (desde && ate && new Date(ate) < new Date(desde)) {
        return reply.status(400).send({
          error: 'DADOS_INVALIDOS',
          message: 'O periodo e invalido: `ate` deve ser >= `desde`.',
        })
      }

      const offset = (page - 1) * limit

      const base = db('logs_auditoria as la')
        .leftJoin('usuarios as u', 'la.usuario_id', 'u.id')
        .modify((qb) => {
          if (usuario_id) {
            qb.where('la.usuario_id', usuario_id)
          }
          if (acao) {
            qb.where('la.acao', acao)
          }
          if (desde) {
            qb.where('la.timestamp', '>=', new Date(desde))
          }
          if (ate) {
            qb.where('la.timestamp', '<=', new Date(ate))
          }
        })

      const [countRow] = await base.clone().count('la.id as total')
      const total = Number((countRow as { total: string | number }).total ?? 0)

      const rows = await base
        .clone()
        .select(
          'la.id',
          'la.usuario_id',
          'u.nome as usuario_nome',
          'u.email as usuario_email',
          'la.acao',
          'la.detalhes',
          'la.ip_origem',
          'la.timestamp',
        )
        .orderBy('la.timestamp', 'desc')
        .limit(limit)
        .offset(offset)

      return reply.status(200).send({
        data: rows.map((r) => serializeRow(r as Record<string, unknown>)),
        page,
        limit,
        total,
      })
    },
  )

  app.get(
    '/logs-auditoria/:id',
    {
      preHandler: [authenticate],
      attachValidation: true,
      schema: {
        tags: ['logs-auditoria'],
        summary: 'Obter log de auditoria por id (ADMIN ou GERENTE)',
        description: 'Somente ADMIN ou GERENTE.',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: {
          200: logAuditoriaItemSchema,
          400: { description: 'Id invalido', ...errorResponseSchema },
          401: {
            description: 'Token invalido/ausente',
            ...errorResponseSchema,
          },
          403: { description: 'Sem permissao', ...errorResponseSchema },
          404: { description: 'Nao encontrado', ...errorResponseSchema },
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

      if (!isAdminOuGerente(request)) {
        return reply.status(403).send(forbiddenError())
      }

      const parsed = z
        .object({ id: z.string().uuid() })
        .safeParse(request.params)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'DADOS_INVALIDOS',
          message: 'O id na URL deve ser um UUID valido.',
        })
      }

      const row = await db('logs_auditoria as la')
        .leftJoin('usuarios as u', 'la.usuario_id', 'u.id')
        .select(
          'la.id',
          'la.usuario_id',
          'u.nome as usuario_nome',
          'u.email as usuario_email',
          'la.acao',
          'la.detalhes',
          'la.ip_origem',
          'la.timestamp',
        )
        .where('la.id', parsed.data.id)
        .first()

      if (!row) {
        return reply.status(404).send({
          error: 'NAO_ENCONTRADO',
          message: 'Log de auditoria nao encontrado.',
        })
      }

      return reply
        .status(200)
        .send(serializeRow(row as Record<string, unknown>))
    },
  )
}
