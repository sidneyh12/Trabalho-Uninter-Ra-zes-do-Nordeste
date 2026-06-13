import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { z } from 'zod'

import { isAdminOuGerente } from '../authz/perfis.js'
import { db } from '../database.js'
import {
  forbiddenError,
  invalidMovimentacaoEstoqueCreationPayloadError,
  invalidMovimentacaoEstoqueUpdatePayloadError,
} from '../http/errors.js'
import { authenticate } from '../middlewares/authenticate.js'
import {
  AcaoAuditoria,
  getUsuarioIdFromRequest,
  registrarLogAuditoria,
} from '../services/audit-log.js'

// Movimentações de estoque = histórico de ENTRADA/SAIDA.
// Cada operação de escrita atualiza estoque.quantidade_atual dentro de transação.

const errorResponseSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    message: { type: 'string' },
  },
  required: ['error', 'message'],
} as const

const TIPOS = ['ENTRADA', 'SAIDA'] as const
type TipoMovimentacao = (typeof TIPOS)[number]

const movimentacaoResponseProps = {
  type: 'object',
  required: [
    'id',
    'unidade_id',
    'produto_id',
    'tipo_movimentacao',
    'quantidade',
    'motivo',
    'criado_em',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    unidade_id: { type: 'string', format: 'uuid' },
    produto_id: { type: 'string', format: 'uuid' },
    tipo_movimentacao: { type: 'string', enum: [...TIPOS] },
    quantidade: { type: 'integer' },
    motivo: { type: ['string', 'null'] },
    criado_em: { type: 'string', format: 'date-time' },
  },
} as const

async function validarUnidadeProduto(
  trx: Knex.Transaction,
  unidadeId: string,
  produtoId: string,
) {
  const unidade = await trx('unidades')
    .select('id')
    .where({ id: unidadeId })
    .first()
  if (!unidade)
    return { ok: false as const, message: 'Unidade nao encontrada.' }

  const produto = await trx('produtos')
    .select('id')
    .where({ id: produtoId })
    .first()
  if (!produto)
    return { ok: false as const, message: 'Produto nao encontrado.' }

  return { ok: true as const }
}

async function buscarOuCriarEstoque(
  trx: Knex.Transaction,
  unidadeId: string,
  produtoId: string,
) {
  let estoque = await trx('estoque')
    .where({ unidade_id: unidadeId, produto_id: produtoId })
    .first()
  if (!estoque) {
    const novoId = randomUUID()
    await trx('estoque').insert({
      id: novoId,
      unidade_id: unidadeId,
      produto_id: produtoId,
      quantidade_atual: 0,
      ponto_reposicao: 0,
    })
    estoque = await trx('estoque').where({ id: novoId }).first()
  }
  return estoque as { id: string; quantidade_atual: number | string }
}

// ENTRADA soma no saldo; SAIDA subtrai (e barra se ficar negativo)
async function aplicarMovimentacaoNoEstoque(
  trx: Knex.Transaction,
  unidadeId: string,
  produtoId: string,
  tipo: TipoMovimentacao,
  quantidade: number,
) {
  const estoque = await buscarOuCriarEstoque(trx, unidadeId, produtoId)
  const atual = Number(estoque.quantidade_atual)
  const novo = tipo === 'ENTRADA' ? atual + quantidade : atual - quantidade

  if (novo < 0) {
    return {
      ok: false as const,
      message: `Estoque insuficiente. Disponivel: ${atual}.`,
    }
  }

  await trx('estoque')
    .where({ id: estoque.id })
    .update({ quantidade_atual: novo })
  return { ok: true as const }
}

// Usado no PUT/DELETE: desfaz o efeito da movimentação antiga no estoque
async function reverterMovimentacaoNoEstoque(
  trx: Knex.Transaction,
  unidadeId: string,
  produtoId: string,
  tipo: TipoMovimentacao,
  quantidade: number,
) {
  const estoque = await trx('estoque')
    .where({ unidade_id: unidadeId, produto_id: produtoId })
    .first()
  if (!estoque) {
    return {
      ok: false as const,
      message: 'Estoque nao encontrado para reverter movimentacao.',
    }
  }

  const atual = Number(estoque.quantidade_atual)
  const novo = tipo === 'ENTRADA' ? atual - quantidade : atual + quantidade
  if (novo < 0) {
    return {
      ok: false as const,
      message:
        'Nao e possivel reverter: o saldo atual ficou inconsistente para esta operacao.',
    }
  }

  await trx('estoque')
    .where({ id: estoque.id })
    .update({ quantidade_atual: novo })
  return { ok: true as const }
}

function serializeMovimentacao(row: Record<string, unknown>) {
  return {
    id: row.id,
    unidade_id: row.unidade_id,
    produto_id: row.produto_id,
    tipo_movimentacao: row.tipo_movimentacao,
    quantidade: Number(row.quantidade),
    motivo: row.motivo ?? null,
    criado_em:
      row.criado_em instanceof Date
        ? row.criado_em.toISOString()
        : String(row.criado_em),
  }
}

export async function movimentacoesEstoqueRoutes(app: FastifyInstance) {
  // Lista movimentações — filtros opcionais na query string
  app.get(
    '/movimentacoes-estoque',
    {
      preHandler: [authenticate],
      attachValidation: true,
      schema: {
        tags: ['movimentacoes-estoque'],
        summary: 'Listar movimentacoes de estoque',
        description:
          'Lista movimentacoes com paginacao e filtros opcionais por unidade, produto e tipo. **Qualquer perfil autenticado.**',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
            unidade_id: { type: 'string', format: 'uuid' },
            produto_id: { type: 'string', format: 'uuid' },
            tipo_movimentacao: { type: 'string', enum: [...TIPOS] },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['data', 'page', 'limit', 'total'],
            properties: {
              data: { type: 'array', items: movimentacaoResponseProps },
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
            'Parametros invalidos. Use page >= 1, limit entre 1 e 100 e filtros de UUID/tipo validos.',
        })
      }

      const q = request.query as {
        page?: number
        limit?: number
        unidade_id?: string
        produto_id?: string
        tipo_movimentacao?: TipoMovimentacao
      }

      const page = typeof q.page === 'number' && q.page >= 1 ? q.page : 1
      let limit = typeof q.limit === 'number' && q.limit >= 1 ? q.limit : 10
      if (limit > 100) limit = 100
      const offset = (page - 1) * limit

      let countQuery = db('movimentacoes_estoque')
      let listQuery = db('movimentacoes_estoque')
        .select(
          'id',
          'unidade_id',
          'produto_id',
          'tipo_movimentacao',
          'quantidade',
          'motivo',
          'criado_em',
        )
        .orderBy('criado_em', 'desc')

      if (q.unidade_id) {
        countQuery = countQuery.where({ unidade_id: q.unidade_id })
        listQuery = listQuery.where({ unidade_id: q.unidade_id })
      }
      if (q.produto_id) {
        countQuery = countQuery.where({ produto_id: q.produto_id })
        listQuery = listQuery.where({ produto_id: q.produto_id })
      }
      if (q.tipo_movimentacao) {
        countQuery = countQuery.where({
          tipo_movimentacao: q.tipo_movimentacao,
        })
        listQuery = listQuery.where({ tipo_movimentacao: q.tipo_movimentacao })
      }

      const [countRow] = await countQuery.count('* as total')
      const total = Number((countRow as { total: string }).total ?? 0)
      const rows = await listQuery.limit(limit).offset(offset)

      return reply.status(200).send({
        data: rows.map((r) =>
          serializeMovimentacao(r as Record<string, unknown>),
        ),
        page,
        limit,
        total,
      })
    },
  )

  app.get(
    '/movimentacoes-estoque/:id',
    {
      preHandler: [authenticate],
      attachValidation: true,
      schema: {
        tags: ['movimentacoes-estoque'],
        summary: 'Buscar movimentacao por id',
        description:
          'Retorna uma movimentacao de estoque pelo UUID. **Qualquer perfil autenticado.**',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: {
          200: movimentacaoResponseProps,
          400: { description: 'Id invalido', ...errorResponseSchema },
          401: {
            description: 'Token invalido/ausente',
            ...errorResponseSchema,
          },
          404: {
            description: 'Movimentacao nao encontrada',
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

      const paramsSchema = z.object({ id: z.string().uuid() })
      const parsed = paramsSchema.safeParse(request.params)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'DADOS_INVALIDOS',
          message: 'O id na URL deve ser um UUID valido.',
        })
      }

      const row = await db('movimentacoes_estoque')
        .select(
          'id',
          'unidade_id',
          'produto_id',
          'tipo_movimentacao',
          'quantidade',
          'motivo',
          'criado_em',
        )
        .where({ id: parsed.data.id })
        .first()

      if (!row) {
        return reply.status(404).send({
          error: 'NAO_ENCONTRADO',
          message: 'Movimentacao nao encontrada.',
        })
      }

      return reply
        .status(200)
        .send(serializeMovimentacao(row as Record<string, unknown>))
    },
  )

  // POST — cria movimentação e ajusta estoque na mesma transação do banco
  app.post(
    '/movimentacoes-estoque',
    {
      preHandler: [authenticate],
      attachValidation: true,
      schema: {
        tags: ['movimentacoes-estoque'],
        summary: 'Criar movimentacao (ADMIN ou GERENTE)',
        description:
          'Cria movimentacao de ENTRADA/SAIDA e atualiza saldo no estoque de forma transacional. **Perfil ADMIN ou GERENTE.**',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: [
            'unidade_id',
            'produto_id',
            'tipo_movimentacao',
            'quantidade',
          ],
          properties: {
            unidade_id: { type: 'string', format: 'uuid' },
            produto_id: { type: 'string', format: 'uuid' },
            tipo_movimentacao: { type: 'string', enum: [...TIPOS] },
            quantidade: { type: 'integer', minimum: 1 },
            motivo: { type: 'string' },
          },
        },
        response: {
          201: movimentacaoResponseProps,
          400: { description: 'Payload invalido', ...errorResponseSchema },
          401: {
            description: 'Token invalido/ausente',
            ...errorResponseSchema,
          },
          403: { description: 'Perfil sem permissao', ...errorResponseSchema },
          404: {
            description: 'Unidade/produto nao encontrado',
            ...errorResponseSchema,
          },
          409: { description: 'Estoque insuficiente', ...errorResponseSchema },
        },
      },
    },
    async (request, reply) => {
      if (request.validationError) {
        return reply
          .status(400)
          .send(invalidMovimentacaoEstoqueCreationPayloadError())
      }
      if (!isAdminOuGerente(request)) {
        return reply.status(403).send(forbiddenError())
      }

      const bodySchema = z.object({
        unidade_id: z.string().uuid(),
        produto_id: z.string().uuid(),
        tipo_movimentacao: z.enum(TIPOS),
        quantidade: z.number().int().min(1),
        motivo: z
          .string()
          .optional()
          .transform((s) => (s === undefined ? undefined : s.trim() || null)),
      })
      const parsed = bodySchema.safeParse(request.body)
      if (!parsed.success) {
        return reply
          .status(400)
          .send(invalidMovimentacaoEstoqueCreationPayloadError())
      }

      const id = randomUUID()
      const { unidade_id, produto_id, tipo_movimentacao, quantidade, motivo } =
        parsed.data

      const result = await db.transaction(async (trx) => {
        const fk = await validarUnidadeProduto(trx, unidade_id, produto_id)
        if (!fk.ok)
          return {
            status: 404 as const,
            body: { error: 'NAO_ENCONTRADO', message: fk.message },
          }

        const ajuste = await aplicarMovimentacaoNoEstoque(
          trx,
          unidade_id,
          produto_id,
          tipo_movimentacao,
          quantidade,
        )
        if (!ajuste.ok) {
          return {
            status: 409 as const,
            body: { error: 'ESTOQUE_INSUFICIENTE', message: ajuste.message },
          }
        }

        await trx('movimentacoes_estoque').insert({
          id,
          unidade_id,
          produto_id,
          tipo_movimentacao,
          quantidade,
          motivo: motivo ?? null,
          criado_em: trx.fn.now(),
        })

        const created = await trx('movimentacoes_estoque')
          .select(
            'id',
            'unidade_id',
            'produto_id',
            'tipo_movimentacao',
            'quantidade',
            'motivo',
            'criado_em',
          )
          .where({ id })
          .first()

        return {
          status: 201 as const,
          body: serializeMovimentacao(created as Record<string, unknown>),
        }
      })

      if (result.status === 201) {
        const uid = getUsuarioIdFromRequest(request)
        const row = result.body as { id: string }
        if (uid && row?.id) {
          await registrarLogAuditoria(request.log, {
            usuarioId: uid,
            acao: AcaoAuditoria.MOVIMENTACAO_ESTOQUE_CREATE,
            detalhes: JSON.stringify({ movimentacao_id: row.id }),
            ipOrigem: request.ip,
          })
        }
      }

      return reply.status(result.status).send(result.body)
    },
  )

  // PUT — reverte a movimentação antiga e aplica a nova (tudo em transaction)
  app.put(
    '/movimentacoes-estoque/:id',
    {
      preHandler: [authenticate],
      attachValidation: true,
      schema: {
        tags: ['movimentacoes-estoque'],
        summary: 'Atualizar movimentacao (ADMIN ou GERENTE)',
        description:
          'Atualiza uma movimentacao e recalcula o saldo: reverte o efeito antigo e aplica o novo, dentro de transacao. **Perfil ADMIN ou GERENTE.**',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          properties: {
            unidade_id: { type: 'string', format: 'uuid' },
            produto_id: { type: 'string', format: 'uuid' },
            tipo_movimentacao: { type: 'string', enum: [...TIPOS] },
            quantidade: { type: 'integer', minimum: 1 },
            motivo: { type: ['string', 'null'] },
          },
          minProperties: 1,
        },
        response: {
          200: movimentacaoResponseProps,
          400: { description: 'Payload invalido', ...errorResponseSchema },
          401: {
            description: 'Token invalido/ausente',
            ...errorResponseSchema,
          },
          403: { description: 'Perfil sem permissao', ...errorResponseSchema },
          404: {
            description: 'Movimentacao/unidade/produto nao encontrado',
            ...errorResponseSchema,
          },
          409: { description: 'Conflito de saldo', ...errorResponseSchema },
        },
      },
    },
    async (request, reply) => {
      if (request.validationError) {
        return reply
          .status(400)
          .send(invalidMovimentacaoEstoqueUpdatePayloadError())
      }
      if (!isAdminOuGerente(request)) {
        return reply.status(403).send(forbiddenError())
      }

      const paramsSchema = z.object({ id: z.string().uuid() })
      const bodySchema = z
        .object({
          unidade_id: z.string().uuid().optional(),
          produto_id: z.string().uuid().optional(),
          tipo_movimentacao: z.enum(TIPOS).optional(),
          quantidade: z.number().int().min(1).optional(),
          motivo: z.union([z.string(), z.null()]).optional(),
        })
        .refine(
          (d) =>
            d.unidade_id !== undefined ||
            d.produto_id !== undefined ||
            d.tipo_movimentacao !== undefined ||
            d.quantidade !== undefined ||
            d.motivo !== undefined,
        )

      const p = paramsSchema.safeParse(request.params)
      const b = bodySchema.safeParse(request.body)
      if (!p.success) {
        return reply.status(400).send({
          error: 'DADOS_INVALIDOS',
          message: 'O id na URL deve ser um UUID valido.',
        })
      }
      if (!b.success) {
        return reply
          .status(400)
          .send(invalidMovimentacaoEstoqueUpdatePayloadError())
      }

      const result = await db.transaction(async (trx) => {
        const atual = await trx('movimentacoes_estoque')
          .where({ id: p.data.id })
          .first()
        if (!atual) {
          return {
            status: 404 as const,
            body: {
              error: 'NAO_ENCONTRADO',
              message: 'Movimentacao nao encontrada.',
            },
          }
        }

        const old = {
          unidade_id: String(atual.unidade_id),
          produto_id: String(atual.produto_id),
          tipo_movimentacao: String(
            atual.tipo_movimentacao,
          ) as TipoMovimentacao,
          quantidade: Number(atual.quantidade),
        }
        const next = {
          unidade_id: b.data.unidade_id ?? old.unidade_id,
          produto_id: b.data.produto_id ?? old.produto_id,
          tipo_movimentacao: b.data.tipo_movimentacao ?? old.tipo_movimentacao,
          quantidade: b.data.quantidade ?? old.quantidade,
          motivo:
            b.data.motivo === undefined
              ? atual.motivo
              : b.data.motivo === null
                ? null
                : b.data.motivo.trim() || null,
        }

        const fk = await validarUnidadeProduto(
          trx,
          next.unidade_id,
          next.produto_id,
        )
        if (!fk.ok)
          return {
            status: 404 as const,
            body: { error: 'NAO_ENCONTRADO', message: fk.message },
          }

        const revert = await reverterMovimentacaoNoEstoque(
          trx,
          old.unidade_id,
          old.produto_id,
          old.tipo_movimentacao,
          old.quantidade,
        )
        if (!revert.ok) {
          return {
            status: 409 as const,
            body: { error: 'CONFLITO', message: revert.message },
          }
        }

        const apply = await aplicarMovimentacaoNoEstoque(
          trx,
          next.unidade_id,
          next.produto_id,
          next.tipo_movimentacao,
          next.quantidade,
        )
        if (!apply.ok) {
          return {
            status: 409 as const,
            body: { error: 'ESTOQUE_INSUFICIENTE', message: apply.message },
          }
        }

        await trx('movimentacoes_estoque').where({ id: p.data.id }).update({
          unidade_id: next.unidade_id,
          produto_id: next.produto_id,
          tipo_movimentacao: next.tipo_movimentacao,
          quantidade: next.quantidade,
          motivo: next.motivo,
        })

        const updated = await trx('movimentacoes_estoque')
          .select(
            'id',
            'unidade_id',
            'produto_id',
            'tipo_movimentacao',
            'quantidade',
            'motivo',
            'criado_em',
          )
          .where({ id: p.data.id })
          .first()

        return {
          status: 200 as const,
          body: serializeMovimentacao(updated as Record<string, unknown>),
        }
      })

      if (result.status === 200) {
        const uid = getUsuarioIdFromRequest(request)
        const row = result.body as { id: string }
        if (uid && row?.id) {
          await registrarLogAuditoria(request.log, {
            usuarioId: uid,
            acao: AcaoAuditoria.MOVIMENTACAO_ESTOQUE_UPDATE,
            detalhes: JSON.stringify({ movimentacao_id: row.id }),
            ipOrigem: request.ip,
          })
        }
      }

      return reply.status(result.status).send(result.body)
    },
  )

  // DELETE — remove o registro e reverte o saldo no estoque
  app.delete(
    '/movimentacoes-estoque/:id',
    {
      preHandler: [authenticate],
      attachValidation: true,
      schema: {
        tags: ['movimentacoes-estoque'],
        summary: 'Remover movimentacao (ADMIN ou GERENTE)',
        description:
          'Exclui uma movimentacao e reverte seu efeito no estoque dentro de transacao. **Perfil ADMIN ou GERENTE.**',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: {
          204: { description: 'Movimentacao removida' },
          400: { description: 'Id invalido', ...errorResponseSchema },
          401: {
            description: 'Token invalido/ausente',
            ...errorResponseSchema,
          },
          403: { description: 'Perfil sem permissao', ...errorResponseSchema },
          404: {
            description: 'Movimentacao nao encontrada',
            ...errorResponseSchema,
          },
          409: {
            description: 'Conflito ao reverter estoque',
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
      if (!isAdminOuGerente(request)) {
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

      const result = await db.transaction(async (trx) => {
        const row = await trx('movimentacoes_estoque')
          .where({ id: parsed.data.id })
          .first()
        if (!row) {
          return {
            status: 404 as const,
            body: {
              error: 'NAO_ENCONTRADO',
              message: 'Movimentacao nao encontrada.',
            },
          }
        }

        const revert = await reverterMovimentacaoNoEstoque(
          trx,
          String(row.unidade_id),
          String(row.produto_id),
          String(row.tipo_movimentacao) as TipoMovimentacao,
          Number(row.quantidade),
        )
        if (!revert.ok) {
          return {
            status: 409 as const,
            body: { error: 'CONFLITO', message: revert.message },
          }
        }

        await trx('movimentacoes_estoque').where({ id: parsed.data.id }).del()
        return { status: 204 as const, body: null }
      })

      if (result.status === 204) {
        const uid = getUsuarioIdFromRequest(request)
        if (uid) {
          await registrarLogAuditoria(request.log, {
            usuarioId: uid,
            acao: AcaoAuditoria.MOVIMENTACAO_ESTOQUE_DELETE,
            detalhes: JSON.stringify({ movimentacao_id: parsed.data.id }),
            ipOrigem: request.ip,
          })
        }
        return reply.status(204).send()
      }
      return reply.status(result.status).send(result.body)
    },
  )
}
