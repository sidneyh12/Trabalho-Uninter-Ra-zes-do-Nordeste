import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { isAdminOuGerente } from '../authz/perfis.js'
import { db } from '../database.js'
import { forbiddenError, invalidPayloadError } from '../http/errors.js'
import { authenticate } from '../middlewares/authenticate.js'
import {
  AcaoAuditoria,
  getUsuarioIdFromRequest,
  registrarLogAuditoria,
} from '../services/audit-log.js'

const errorResponseSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    message: { type: 'string' },
  },
  required: ['error', 'message'],
} as const

function serializeCampanha(row: Record<string, unknown>) {
  const vd =
    row.valido_de instanceof Date
      ? row.valido_de.toISOString()
      : String(row.valido_de)
  const va =
    row.valido_ate instanceof Date
      ? row.valido_ate.toISOString()
      : String(row.valido_ate)
  return {
    id: row.id,
    nome: row.nome,
    descricao: row.descricao ?? null,
    percentual_desconto: Number(row.percentual_desconto),
    valido_de: vd,
    valido_ate: va,
    ativa: Boolean(row.ativa),
    unidade_id: row.unidade_id ?? null,
    criado_em:
      row.criado_em instanceof Date
        ? row.criado_em.toISOString()
        : String(row.criado_em),
  }
}

const campanhaResponseProps = {
  type: 'object',
  required: [
    'id',
    'nome',
    'descricao',
    'percentual_desconto',
    'valido_de',
    'valido_ate',
    'ativa',
    'unidade_id',
    'criado_em',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    nome: { type: 'string' },
    descricao: { type: ['string', 'null'] },
    percentual_desconto: { type: 'number' },
    valido_de: { type: 'string', format: 'date-time' },
    valido_ate: { type: 'string', format: 'date-time' },
    ativa: { type: 'boolean' },
    unidade_id: { type: ['string', 'null'], format: 'uuid' },
    criado_em: { type: 'string', format: 'date-time' },
  },
} as const

export async function campanhasRoutes(app: FastifyInstance) {
  app.get(
    '/campanhas',
    {
      preHandler: [authenticate],
      attachValidation: true,
      schema: {
        tags: ['campanhas'],
        summary: 'Listar campanhas promocionais',
        description:
          'Lista campanhas com paginacao. Qualquer usuario autenticado pode consultar para aplicar `campanha_id` no pedido. Filtros opcionais: apenas ativas e por unidade.',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
            ativas: {
              type: 'boolean',
              description: 'Se true, apenas campanhas ativas no periodo atual',
            },
            unidade_id: { type: 'string', format: 'uuid' },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['data', 'page', 'limit', 'total'],
            properties: {
              data: { type: 'array', items: campanhaResponseProps },
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

      const q = request.query as {
        page?: number
        limit?: number
        ativas?: boolean
        unidade_id?: string
      }
      const page = typeof q.page === 'number' && q.page >= 1 ? q.page : 1
      let limit = typeof q.limit === 'number' && q.limit >= 1 ? q.limit : 10
      if (limit > 100) limit = 100
      const offset = (page - 1) * limit

      let countQuery = db('campanhas')
      let listQuery = db('campanhas').select('*').orderBy('valido_de', 'desc')

      if (q.ativas === true) {
        const now = db.fn.now()
        countQuery = countQuery
          .where({ ativa: true })
          .where('valido_de', '<=', now)
          .where('valido_ate', '>=', now)
        listQuery = listQuery
          .where({ ativa: true })
          .where('valido_de', '<=', now)
          .where('valido_ate', '>=', now)
      }

      if (q.unidade_id) {
        countQuery = countQuery.where(function () {
          this.whereNull('unidade_id').orWhere('unidade_id', q.unidade_id)
        })
        listQuery = listQuery.where(function () {
          this.whereNull('unidade_id').orWhere('unidade_id', q.unidade_id)
        })
      }

      const [countRow] = await countQuery.count('* as total')
      const total = Number((countRow as { total: string }).total ?? 0)
      const rows = await listQuery.limit(limit).offset(offset)

      return reply.status(200).send({
        data: rows.map((r) => serializeCampanha(r as Record<string, unknown>)),
        page,
        limit,
        total,
      })
    },
  )

  app.get(
    '/campanhas/:id',
    {
      preHandler: [authenticate],
      attachValidation: true,
      schema: {
        tags: ['campanhas'],
        summary: 'Buscar campanha por id',
        description: '**Qualquer perfil autenticado.**',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: {
          200: campanhaResponseProps,
          400: { description: 'Id invalido', ...errorResponseSchema },
          401: {
            description: 'Token invalido/ausente',
            ...errorResponseSchema,
          },
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

      const parsed = z
        .object({ id: z.string().uuid() })
        .safeParse(request.params)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'DADOS_INVALIDOS',
          message: 'O id na URL deve ser um UUID valido.',
        })
      }

      const row = await db('campanhas').where({ id: parsed.data.id }).first()
      if (!row) {
        return reply.status(404).send({
          error: 'NAO_ENCONTRADO',
          message: 'Campanha nao encontrada.',
        })
      }

      return reply
        .status(200)
        .send(serializeCampanha(row as Record<string, unknown>))
    },
  )

  app.post(
    '/campanhas',
    {
      preHandler: [authenticate],
      attachValidation: true,
      schema: {
        tags: ['campanhas'],
        summary: 'Criar campanha (ADMIN ou GERENTE)',
        description: '**Perfil ADMIN ou GERENTE.** Demais perfis recebem 403.',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['nome', 'percentual_desconto', 'valido_de', 'valido_ate'],
          properties: {
            nome: { type: 'string', minLength: 1 },
            descricao: { type: 'string' },
            percentual_desconto: { type: 'number', minimum: 0, maximum: 100 },
            valido_de: { type: 'string', format: 'date-time' },
            valido_ate: { type: 'string', format: 'date-time' },
            ativa: { type: 'boolean' },
            unidade_id: { type: 'string', format: 'uuid' },
          },
        },
        response: {
          201: campanhaResponseProps,
          400: { description: 'Payload invalido', ...errorResponseSchema },
          401: {
            description: 'Token invalido/ausente',
            ...errorResponseSchema,
          },
          403: { description: 'Sem permissao', ...errorResponseSchema },
          404: { description: 'Unidade invalida', ...errorResponseSchema },
        },
      },
    },
    async (request, reply) => {
      if (request.validationError) {
        return reply.status(400).send(invalidPayloadError())
      }
      if (!isAdminOuGerente(request)) {
        return reply.status(403).send(forbiddenError())
      }

      const bodySchema = z.object({
        nome: z.string().trim().min(1),
        descricao: z.string().optional(),
        percentual_desconto: z.number().min(0).max(100),
        valido_de: z.string().min(1),
        valido_ate: z.string().min(1),
        ativa: z.boolean().optional(),
        unidade_id: z.string().uuid().optional(),
      })

      const pb = bodySchema.safeParse(request.body)
      if (!pb.success) {
        return reply.status(400).send(invalidPayloadError())
      }

      const ini = new Date(pb.data.valido_de)
      const fim = new Date(pb.data.valido_ate)
      if (ini >= fim) {
        return reply.status(400).send({
          error: 'DADOS_INVALIDOS',
          message: 'valido_de deve ser anterior a valido_ate.',
        })
      }

      if (pb.data.unidade_id) {
        const u = await db('unidades')
          .select('id')
          .where({ id: pb.data.unidade_id })
          .first()
        if (!u) {
          return reply.status(404).send({
            error: 'NAO_ENCONTRADO',
            message: 'Unidade nao encontrada.',
          })
        }
      }

      const id = randomUUID()
      await db('campanhas').insert({
        id,
        nome: pb.data.nome,
        descricao: pb.data.descricao ?? null,
        percentual_desconto: pb.data.percentual_desconto,
        valido_de: ini,
        valido_ate: fim,
        ativa: pb.data.ativa ?? true,
        unidade_id: pb.data.unidade_id ?? null,
        criado_em: db.fn.now(),
      })

      const row = await db('campanhas').where({ id }).first()

      const actorId = getUsuarioIdFromRequest(request)
      if (actorId) {
        await registrarLogAuditoria(request.log, {
          usuarioId: actorId,
          acao: AcaoAuditoria.CAMPANHA_CREATE,
          detalhes: JSON.stringify({ campanha_criada_id: id }),
          ipOrigem: request.ip,
        })
      }

      return reply
        .status(201)
        .send(serializeCampanha(row as Record<string, unknown>))
    },
  )

  app.put(
    '/campanhas/:id',
    {
      preHandler: [authenticate],
      attachValidation: true,
      schema: {
        tags: ['campanhas'],
        summary: 'Atualizar campanha (ADMIN ou GERENTE)',
        description: '**Perfil ADMIN ou GERENTE.**',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          properties: {
            nome: { type: 'string', minLength: 1 },
            descricao: { type: ['string', 'null'] },
            percentual_desconto: { type: 'number', minimum: 0, maximum: 100 },
            valido_de: { type: 'string', format: 'date-time' },
            valido_ate: { type: 'string', format: 'date-time' },
            ativa: { type: 'boolean' },
            unidade_id: { type: ['string', 'null'], format: 'uuid' },
          },
          minProperties: 1,
        },
        response: {
          200: campanhaResponseProps,
          400: { description: 'Payload invalido', ...errorResponseSchema },
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
          message: 'Informe ao menos um campo valido para atualizar.',
        })
      }
      if (!isAdminOuGerente(request)) {
        return reply.status(403).send(forbiddenError())
      }

      const paramsSchema = z.object({ id: z.string().uuid() })
      const bodySchema = z
        .object({
          nome: z.string().trim().min(1).optional(),
          descricao: z.union([z.string(), z.null()]).optional(),
          percentual_desconto: z.number().min(0).max(100).optional(),
          valido_de: z.string().min(1).optional(),
          valido_ate: z.string().min(1).optional(),
          ativa: z.boolean().optional(),
          unidade_id: z.union([z.string().uuid(), z.null()]).optional(),
        })
        .refine((d) => Object.keys(d).length > 0)

      const pp = paramsSchema.safeParse(request.params)
      const pb = bodySchema.safeParse(request.body)
      if (!pp.success) {
        return reply.status(400).send({
          error: 'DADOS_INVALIDOS',
          message: 'O id na URL deve ser um UUID valido.',
        })
      }
      if (!pb.success) {
        return reply.status(400).send(invalidPayloadError())
      }

      const existing = await db('campanhas').where({ id: pp.data.id }).first()
      if (!existing) {
        return reply.status(404).send({
          error: 'NAO_ENCONTRADO',
          message: 'Campanha nao encontrada.',
        })
      }

      const vd =
        pb.data.valido_de !== undefined
          ? new Date(pb.data.valido_de)
          : new Date(String(existing.valido_de))
      const va =
        pb.data.valido_ate !== undefined
          ? new Date(pb.data.valido_ate)
          : new Date(String(existing.valido_ate))
      if (vd >= va) {
        return reply.status(400).send({
          error: 'DADOS_INVALIDOS',
          message: 'valido_de deve ser anterior a valido_ate.',
        })
      }

      if (pb.data.unidade_id) {
        const u = await db('unidades')
          .select('id')
          .where({ id: pb.data.unidade_id })
          .first()
        if (!u) {
          return reply.status(404).send({
            error: 'NAO_ENCONTRADO',
            message: 'Unidade nao encontrada.',
          })
        }
      }

      const patch: Record<string, unknown> = {}
      if (pb.data.nome !== undefined) patch.nome = pb.data.nome
      if (pb.data.descricao !== undefined) patch.descricao = pb.data.descricao
      if (pb.data.percentual_desconto !== undefined)
        patch.percentual_desconto = pb.data.percentual_desconto
      if (pb.data.valido_de !== undefined) patch.valido_de = vd
      if (pb.data.valido_ate !== undefined) patch.valido_ate = va
      if (pb.data.ativa !== undefined) patch.ativa = pb.data.ativa
      if (pb.data.unidade_id !== undefined)
        patch.unidade_id = pb.data.unidade_id

      await db('campanhas').where({ id: pp.data.id }).update(patch)
      const row = await db('campanhas').where({ id: pp.data.id }).first()

      const actorId = getUsuarioIdFromRequest(request)
      if (actorId) {
        await registrarLogAuditoria(request.log, {
          usuarioId: actorId,
          acao: AcaoAuditoria.CAMPANHA_UPDATE,
          detalhes: JSON.stringify({ campanha_atualizada_id: pp.data.id }),
          ipOrigem: request.ip,
        })
      }

      return reply
        .status(200)
        .send(serializeCampanha(row as Record<string, unknown>))
    },
  )

  app.delete(
    '/campanhas/:id',
    {
      preHandler: [authenticate],
      attachValidation: true,
      schema: {
        tags: ['campanhas'],
        summary: 'Remover campanha (ADMIN ou GERENTE)',
        description: '**Perfil ADMIN ou GERENTE.**',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: {
          204: { description: 'Removido' },
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

      const deleted = await db('campanhas').where({ id: parsed.data.id }).del()
      if (deleted === 0) {
        return reply.status(404).send({
          error: 'NAO_ENCONTRADO',
          message: 'Campanha nao encontrada.',
        })
      }

      const actorId = getUsuarioIdFromRequest(request)
      if (actorId) {
        await registrarLogAuditoria(request.log, {
          usuarioId: actorId,
          acao: AcaoAuditoria.CAMPANHA_DELETE,
          detalhes: JSON.stringify({ campanha_removida_id: parsed.data.id }),
          ipOrigem: request.ip,
        })
      }

      return reply.status(204).send()
    },
  )
}
