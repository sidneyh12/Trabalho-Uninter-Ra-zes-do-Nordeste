import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { z } from 'zod'

import { db } from '../database.js'
import { forbiddenError } from '../http/errors.js'
import { authenticate } from '../middlewares/authenticate.js'

// Pagamentos mock — parte 2/4: GET + POST (registro mock).
// PUT e DELETE nos próximos commits.
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

const pedidoResumoPagamentoProps = {
  type: 'object',
  required: [
    'id',
    'cliente_id',
    'unidade_id',
    'canalPedido',
    'status',
    'valor_total',
    'valor_desconto',
    'campanha_id',
    'criado_em',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    cliente_id: { type: 'string', format: 'uuid' },
    unidade_id: { type: 'string', format: 'uuid' },
    canalPedido: { type: 'string' },
    status: { type: 'string' },
    valor_total: { type: 'number' },
    valor_desconto: { type: 'number' },
    campanha_id: { type: ['string', 'null'], format: 'uuid' },
    criado_em: { type: 'string', format: 'date-time' },
  },
} as const

const pagamentoCreate201ResponseProps = {
  type: 'object',
  required: ['pagamento', 'pedido'],
  properties: {
    pagamento: pagamentoResponseProps,
    pedido: pedidoResumoPagamentoProps,
  },
} as const

// ADMIN e GERENTE veem todos; CLIENTE só dos próprios pedidos
function podeVerTodosPagamentos(request: { user?: unknown }): boolean {
  const perfil = (request.user as { perfil?: string } | undefined)?.perfil
  return perfil === 'ADMIN' || perfil === 'GERENTE'
}

// Dono do pedido ou equipe de loja pode registrar pagamento
function podeOperarPagamento(request: { user?: unknown }): boolean {
  const perfil = (request.user as { perfil?: string } | undefined)?.perfil
  return perfil === 'ADMIN' || perfil === 'GERENTE' || perfil === 'BALCAO'
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

function serializePedidoResumo(row: Record<string, unknown>) {
  return {
    id: row.id,
    cliente_id: row.cliente_id,
    unidade_id: row.unidade_id,
    canalPedido: row.canalPedido,
    status: row.status,
    valor_total: Number(row.valor_total),
    valor_desconto: Number(row.valor_desconto ?? 0),
    campanha_id: row.campanha_id != null ? String(row.campanha_id) : null,
    criado_em:
      row.criado_em instanceof Date
        ? row.criado_em.toISOString()
        : String(row.criado_em),
  }
}

// NEGADO cancela o pedido — devolve quantidade ao estoque da unidade
async function restaurarEstoquePedido(
  trx: Knex.Transaction,
  unidadeId: string,
  pedidoId: string,
) {
  const itensRows = await trx('itens_pedido')
    .select('produto_id', 'quantidade')
    .where({ pedido_id: pedidoId })

  for (const it of itensRows) {
    const estoque = await trx('estoque')
      .where({ unidade_id: unidadeId, produto_id: String(it.produto_id) })
      .first()
    if (estoque) {
      await trx('estoque')
        .where({ id: estoque.id })
        .update({
          quantidade_atual:
            Number(estoque.quantidade_atual) + Number(it.quantidade),
        })
    }
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

  // Mock de gateway — APROVADO avança pedido; NEGADO cancela e devolve estoque
  app.post(
    '/pagamentos',
    {
      preHandler: [authenticate],
      attachValidation: true,
      schema: {
        tags: ['pagamentos'],
        summary: 'Registrar pagamento mock',
        description:
          'Registra pagamento (APROVADO/NEGADO) para pedido em AGUARDANDO_PAGAMENTO. Dono do pedido ou ADMIN/GERENTE/BALCAO. Resposta 201: { pagamento, pedido }.',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['pedido_id', 'metodo_pagamento', 'resultado_mock'],
          properties: {
            pedido_id: { type: 'string', format: 'uuid' },
            metodo_pagamento: { type: 'string', minLength: 1 },
            resultado_mock: { type: 'string', enum: [...RESULTADOS] },
            external_id: { type: 'string' },
            payload_retorno: { type: 'string' },
          },
        },
        response: {
          201: pagamentoCreate201ResponseProps,
          400: { description: 'Payload invalido', ...errorResponseSchema },
          401: {
            description: 'Token invalido/ausente',
            ...errorResponseSchema,
          },
          403: { description: 'Sem permissao', ...errorResponseSchema },
          404: {
            description: 'Pedido nao encontrado',
            ...errorResponseSchema,
          },
          409: {
            description: 'PEDIDO_STATUS_INVALIDO ou PAGAMENTO_JA_REGISTRADO',
            ...errorResponseSchema,
          },
          500: {
            description: 'Inconsistencia apos persistencia',
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
            'Dados invalidos. Informe pedido_id, metodo_pagamento e resultado_mock (APROVADO|NEGADO); external_id e payload_retorno sao opcionais.',
        })
      }

      const sub = getSub(request)
      if (!sub) {
        return reply.status(401).send({
          error: 'NAO_AUTORIZADO',
          message: 'Token invalido.',
        })
      }

      const bodySchema = z.object({
        pedido_id: z.string().uuid(),
        metodo_pagamento: z.string().trim().min(1),
        resultado_mock: z.enum(RESULTADOS),
        external_id: z.string().optional(),
        payload_retorno: z.string().optional(),
      })
      const parsedBody = bodySchema.safeParse(request.body)
      if (!parsedBody.success) {
        return reply.status(400).send({
          error: 'DADOS_INVALIDOS',
          message:
            'Dados invalidos. Informe pedido_id, metodo_pagamento e resultado_mock (APROVADO|NEGADO); external_id e payload_retorno sao opcionais.',
        })
      }

      const pedido = await db('pedidos')
        .where({ id: parsedBody.data.pedido_id })
        .first()
      if (!pedido) {
        return reply.status(404).send({
          error: 'NAO_ENCONTRADO',
          message: 'Pedido nao encontrado.',
        })
      }

      const pedidoClienteId = String(
        (pedido as { cliente_id: string }).cliente_id,
      )
      if (!podeOperarPagamento(request) && pedidoClienteId !== sub) {
        return reply.status(403).send(forbiddenError())
      }

      const statusPedido = String((pedido as { status: string }).status)
      if (statusPedido !== 'AGUARDANDO_PAGAMENTO') {
        return reply.status(409).send({
          error: 'PEDIDO_STATUS_INVALIDO',
          message: `Pagamento so pode ser registrado para pedido em AGUARDANDO_PAGAMENTO. Status atual: ${statusPedido}.`,
        })
      }

      const existing = await db('pagamentos')
        .where({ pedido_id: parsedBody.data.pedido_id })
        .first()
      if (existing) {
        return reply.status(409).send({
          error: 'PAGAMENTO_JA_REGISTRADO',
          message: 'Este pedido ja possui pagamento registrado.',
        })
      }

      const pagamentoId = randomUUID()
      const resultado = await db.transaction(async (trx) => {
        await trx('pagamentos').insert({
          id: pagamentoId,
          pedido_id: parsedBody.data.pedido_id,
          external_id: parsedBody.data.external_id ?? null,
          metodo_pagamento: parsedBody.data.metodo_pagamento,
          status_pagamento: parsedBody.data.resultado_mock,
          payload_retorno: parsedBody.data.payload_retorno ?? null,
        })

        if (parsedBody.data.resultado_mock === 'APROVADO') {
          await trx('pedidos')
            .where({ id: parsedBody.data.pedido_id })
            .update({ status: 'EM_PREPARO' })

          const pedidoPago = await trx('pedidos')
            .where({ id: parsedBody.data.pedido_id })
            .first()
          if (pedidoPago) {
            const clienteId = String(
              (pedidoPago as { cliente_id: string }).cliente_id,
            )
            const valorPedido = Number(
              (pedidoPago as { valor_total: unknown }).valor_total,
            )
            const fid = await trx('fidelidade')
              .where({ cliente_id: clienteId })
              .where({ consentimento_explicitado: true })
              .first()
            if (fid && valorPedido > 0) {
              const pts = Math.floor(valorPedido)
              await trx('fidelidade')
                .where({ id: String((fid as { id: string }).id) })
                .update({
                  saldo_pontos:
                    Number((fid as { saldo_pontos: unknown }).saldo_pontos) +
                    pts,
                  ultima_atualizacao: trx.fn.now(),
                })
            }
          }
        } else {
          await trx('pedidos')
            .where({ id: parsedBody.data.pedido_id })
            .update({ status: 'CANCELADO' })
          await restaurarEstoquePedido(
            trx,
            String((pedido as { unidade_id: string }).unidade_id),
            parsedBody.data.pedido_id,
          )
        }

        const created = await trx('pagamentos')
          .where({ id: pagamentoId })
          .first()
        return created as Record<string, unknown>
      })

      const pedidoAtualizado = await db('pedidos')
        .where({ id: parsedBody.data.pedido_id })
        .first()
      if (!pedidoAtualizado) {
        return reply.status(500).send({
          error: 'ERRO_INTERNO',
          message:
            'Pagamento registrado mas pedido nao encontrado apos atualizacao.',
        })
      }

      return reply.status(201).send({
        pagamento: serializePagamento(resultado),
        pedido: serializePedidoResumo(
          pedidoAtualizado as Record<string, unknown>,
        ),
      })
    },
  )
}
