import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { db } from '../database.js'
import { forbiddenError } from '../http/errors.js'
import { authenticate } from '../middlewares/authenticate.js'

// Pagamentos mock — parte 1/4: somente leitura (GET).
// POST, PUT e DELETE virão nos próximos commits.
// Erros específicos, auditoria, Swagger e README no commit final.

const errorResponseSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    message: { type: 'string' },
  },
  required: ['error', 'message'],
} as const

const RESULTADOS = ['APROVADO', 'NEGADO'] as const
type ResultadoPagamento = (typeof RESULTADOS)[number]

const pagamentoResponseProps = {
  type: 'object',
  required: [
    'id',
    'pedido_id',
    'external_id',
    'metodo_pagamento',
    'status_pagamento',
    'payload_retorno',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    pedido_id: { type: 'string', format: 'uuid' },
    external_id: { type: ['string', 'null'] },
    metodo_pagamento: { type: 'string' },
    status_pagamento: { type: 'string', enum: [...RESULTADOS] },
    payload_retorno: { type: ['string', 'null'] },
  },
} as const

// ADMIN e GERENTE veem todos; CLIENTE só dos próprios pedidos
function podeVerTodosPagamentos(request: { user?: unknown }): boolean {
  const perfil = (request.user as { perfil?: string } | undefined)?.perfil
  return perfil === 'ADMIN' || perfil === 'GERENTE'
}

function getSub(request: { user?: unknown }): string | undefined {
  return (request.user as { sub?: string } | undefined)?.sub
}

function serializePagamento(row: Record<string, unknown>) {
  return {
    id: row.id,
    pedido_id: row.pedido_id,
    external_id: row.external_id ?? null,
    metodo_pagamento: row.metodo_pagamento,
    status_pagamento: row.status_pagamento,
    payload_retorno: row.payload_retorno ?? null,
  }
}

export async function pagamentosRoutes(app: FastifyInstance) {
  // Lista pagamentos — filtros opcionais por pedido e status
  app.get(
    '/pagamentos',
    {
      preHandler: [authenticate],
      attachValidation: true,
      schema: {
        tags: ['pagamentos'],
        summary: 'Listar pagamentos',
        description:
          'Lista pagamentos com paginacao. ADMIN/GERENTE veem todos; demais perfis veem apenas pagamentos dos proprios pedidos.',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
            pedido_id: { type: 'string', format: 'uuid' },
            status_pagamento: { type: 'string', enum: [...RESULTADOS] },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['data', 'page', 'limit', 'total'],
            properties: {
              data: { type: 'array', items: pagamentoResponseProps },
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
          message:
            'Parametros invalidos. Use page >= 1, limit entre 1 e 100 e filtros validos.',
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
        pedido_id?: string
        status_pagamento?: ResultadoPagamento
      }
      const page = typeof q.page === 'number' && q.page >= 1 ? q.page : 1
      let limit = typeof q.limit === 'number' && q.limit >= 1 ? q.limit : 10
      if (limit > 100) limit = 100
      const offset = (page - 1) * limit

      let countQuery = db('pagamentos')
      let listQuery = db('pagamentos')
        .select(
          'pagamentos.id',
          'pagamentos.pedido_id',
          'pagamentos.external_id',
          'pagamentos.metodo_pagamento',
          'pagamentos.status_pagamento',
          'pagamentos.payload_retorno',
        )
        .orderBy('pagamentos.id', 'desc')

      // Cliente comum: join com pedidos para filtrar só os dele
      if (!podeVerTodosPagamentos(request)) {
        countQuery = countQuery
          .join('pedidos', 'pedidos.id', 'pagamentos.pedido_id')
          .where('pedidos.cliente_id', sub)
        listQuery = listQuery
          .join('pedidos', 'pedidos.id', 'pagamentos.pedido_id')
          .where('pedidos.cliente_id', sub)
      }

      if (q.pedido_id) {
        countQuery = countQuery.where('pagamentos.pedido_id', q.pedido_id)
        listQuery = listQuery.where('pagamentos.pedido_id', q.pedido_id)
      }
      if (q.status_pagamento) {
        countQuery = countQuery.where(
          'pagamentos.status_pagamento',
          q.status_pagamento,
        )
        listQuery = listQuery.where(
          'pagamentos.status_pagamento',
          q.status_pagamento,
        )
      }

      const [countRow] = await countQuery.count('* as total')
      const total = Number((countRow as { total: string }).total ?? 0)
      const rows = await listQuery.limit(limit).offset(offset)

      return reply.status(200).send({
        data: rows.map((r) => serializePagamento(r as Record<string, unknown>)),
        page,
        limit,
        total,
      })
    },
  )

  // Detalhe de um pagamento pelo UUID
  app.get(
    '/pagamentos/:id',
    {
      preHandler: [authenticate],
      attachValidation: true,
      schema: {
        tags: ['pagamentos'],
        summary: 'Buscar pagamento por id',
        description:
          'Retorna pagamento por UUID. CLIENTE so acessa pagamento dos proprios pedidos.',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: {
          200: pagamentoResponseProps,
          400: { description: 'Id invalido', ...errorResponseSchema },
          401: {
            description: 'Token invalido/ausente',
            ...errorResponseSchema,
          },
          403: { description: 'Sem permissao', ...errorResponseSchema },
          404: {
            description: 'Pagamento nao encontrado',
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

      const row = await db('pagamentos').where({ id: parsed.data.id }).first()
      if (!row) {
        return reply.status(404).send({
          error: 'NAO_ENCONTRADO',
          message: 'Pagamento nao encontrado.',
        })
      }

      if (!podeVerTodosPagamentos(request)) {
        const pedido = await db('pedidos')
          .select('cliente_id')
          .where({ id: row.pedido_id })
          .first()
        if (!pedido || String(pedido.cliente_id) !== sub) {
          return reply.status(403).send(forbiddenError())
        }
      }

      return reply
        .status(200)
        .send(serializePagamento(row as Record<string, unknown>))
    },
  )
}
