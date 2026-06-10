import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { db } from '../database.js'
import {
  forbiddenError,
  invalidEstoqueCreationPayloadError,
  invalidEstoqueUpdatePayloadError,
} from '../http/errors.js'
import { isAdminOuGerente } from '../authz/perfis.js'
import { authenticate } from '../middlewares/authenticate.js'
import {
  AcaoAuditoria,
  getUsuarioIdFromRequest,
  registrarLogAuditoria,
} from '../services/audit-log.js'

// Estoque = quantidade de cada produto em cada unidade.
// Na migration tem UNIQUE em (unidade_id + produto_id) — não pode duplicar o par.

const errorResponseSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    message: { type: 'string' },
  },
  required: ['error', 'message'],
} as const

const estoqueResponseProps = {
  type: 'object',
  required: [
    'id',
    'unidade_id',
    'produto_id',
    'quantidade_atual',
    'ponto_reposicao',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    unidade_id: { type: 'string', format: 'uuid' },
    produto_id: { type: 'string', format: 'uuid' },
    quantidade_atual: { type: 'integer' },
    ponto_reposicao: { type: 'integer' },
  },
} as const

// Confere se unidade e produto existem antes de criar/alterar estoque
async function validateForeignKeys(unidadeId: string, produtoId: string) {
  const unidade = await db('unidades')
    .select('id')
    .where({ id: unidadeId })
    .first()
  if (!unidade) return { ok: false as const, error: 'Unidade nao encontrada.' }

  const produto = await db('produtos')
    .select('id')
    .where({ id: produtoId })
    .first()
  if (!produto) return { ok: false as const, error: 'Produto nao encontrado.' }

  return { ok: true as const }
}

export async function estoqueRoutes(app: FastifyInstance) {
  // Lista estoque — pode filtrar por unidade_id e/ou produto_id
  app.get(
    '/estoque',
    {
      preHandler: [authenticate],
      attachValidation: true,
      schema: {
        tags: ['estoque'],
        summary: 'Listar estoque',
        description:
          'Lista itens de estoque com paginacao. Filtros opcionais por unidade_id e produto_id. **Qualquer perfil autenticado.**',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
            unidade_id: { type: 'string', format: 'uuid' },
            produto_id: { type: 'string', format: 'uuid' },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['data', 'page', 'limit', 'total'],
            properties: {
              data: { type: 'array', items: estoqueResponseProps },
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
            'Parametros invalidos. Use page >= 1, limit entre 1 e 100 e UUID valido para unidade_id/produto_id.',
        })
      }

      const q = request.query as {
        page?: number
        limit?: number
        unidade_id?: string
        produto_id?: string
      }

      const page = typeof q.page === 'number' && q.page >= 1 ? q.page : 1
      let limit = typeof q.limit === 'number' && q.limit >= 1 ? q.limit : 10
      if (limit > 100) limit = 100
      const offset = (page - 1) * limit

      let countQuery = db('estoque')
      let listQuery = db('estoque')
        .select(
          'id',
          'unidade_id',
          'produto_id',
          'quantidade_atual',
          'ponto_reposicao',
        )
        .orderBy('id', 'asc')

      if (q.unidade_id) {
        countQuery = countQuery.where({ unidade_id: q.unidade_id })
        listQuery = listQuery.where({ unidade_id: q.unidade_id })
      }

      if (q.produto_id) {
        countQuery = countQuery.where({ produto_id: q.produto_id })
        listQuery = listQuery.where({ produto_id: q.produto_id })
      }

      const [countRow] = await countQuery.count('* as total')
      const total = Number((countRow as { total: string }).total ?? 0)
      const data = await listQuery.limit(limit).offset(offset)

      return reply.status(200).send({ data, page, limit, total })
    },
  )

  // Busca um registro de estoque pelo id
  app.get(
    '/estoque/:id',
    {
      preHandler: [authenticate],
      attachValidation: true,
      schema: {
        tags: ['estoque'],
        summary: 'Buscar estoque por id',
        description:
          'Retorna um item de estoque pelo UUID. **Qualquer perfil autenticado.**',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: {
          200: estoqueResponseProps,
          400: { description: 'Id invalido', ...errorResponseSchema },
          401: {
            description: 'Token invalido/ausente',
            ...errorResponseSchema,
          },
          404: {
            description: 'Estoque nao encontrado',
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

      const row = await db('estoque')
        .select(
          'id',
          'unidade_id',
          'produto_id',
          'quantidade_atual',
          'ponto_reposicao',
        )
        .where({ id: parsed.data.id })
        .first()

      if (!row) {
        return reply.status(404).send({
          error: 'NAO_ENCONTRADO',
          message: 'Estoque nao encontrado.',
        })
      }

      return reply.status(200).send(row)
    },
  )

  // Cria linha de estoque — um par unidade + produto só pode existir uma vez
  app.post(
    '/estoque',
    {
      preHandler: [authenticate],
      attachValidation: true,
      schema: {
        tags: ['estoque'],
        summary: 'Criar item de estoque (ADMIN ou GERENTE)',
        description:
          'Cria um registro de estoque por unidade/produto. **Perfil ADMIN ou GERENTE.**',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['unidade_id', 'produto_id'],
          properties: {
            unidade_id: { type: 'string', format: 'uuid' },
            produto_id: { type: 'string', format: 'uuid' },
            quantidade_atual: { type: 'integer', minimum: 0 },
            ponto_reposicao: { type: 'integer', minimum: 0 },
          },
        },
        response: {
          201: estoqueResponseProps,
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
          409: {
            description: 'Conflito de chave unica',
            ...errorResponseSchema,
          },
        },
      },
    },
    async (request, reply) => {
      if (request.validationError) {
        return reply.status(400).send(invalidEstoqueCreationPayloadError())
      }

      if (!isAdminOuGerente(request)) {
        return reply.status(403).send(forbiddenError())
      }

      const bodySchema = z.object({
        unidade_id: z.string().uuid(),
        produto_id: z.string().uuid(),
        quantidade_atual: z.number().int().min(0).optional(),
        ponto_reposicao: z.number().int().min(0).optional(),
      })

      const parsedBody = bodySchema.safeParse(request.body)
      if (!parsedBody.success) {
        return reply.status(400).send(invalidEstoqueCreationPayloadError())
      }

      const { unidade_id, produto_id, quantidade_atual, ponto_reposicao } =
        parsedBody.data

      const fkValidation = await validateForeignKeys(unidade_id, produto_id)
      if (!fkValidation.ok) {
        return reply.status(404).send({
          error: 'NAO_ENCONTRADO',
          message: fkValidation.error,
        })
      }

      // Mesmo produto na mesma unidade = conflito 409
      const duplicate = await db('estoque')
        .where({ unidade_id, produto_id })
        .first()
      if (duplicate) {
        return reply.status(409).send({
          error: 'CONFLITO',
          message:
            'Ja existe registro de estoque para este par unidade/produto.',
        })
      }

      const id = randomUUID()
      await db('estoque').insert({
        id,
        unidade_id,
        produto_id,
        quantidade_atual: quantidade_atual ?? 0,
        ponto_reposicao: ponto_reposicao ?? 0,
      })

      const created = await db('estoque')
        .select(
          'id',
          'unidade_id',
          'produto_id',
          'quantidade_atual',
          'ponto_reposicao',
        )
        .where({ id })
        .first()

      const actorId = getUsuarioIdFromRequest(request)
      if (actorId) {
        await registrarLogAuditoria(request.log, {
          usuarioId: actorId,
          acao: AcaoAuditoria.ESTOQUE_CREATE,
          detalhes: JSON.stringify({ estoque_id: id, unidade_id, produto_id }),
          ipOrigem: request.ip,
        })
      }

      return reply.status(201).send(created)
    },
  )

  // Atualiza quantidade, ponto de reposição ou troca unidade/produto (com cuidado no par único)
  app.put(
    '/estoque/:id',
    {
      preHandler: [authenticate],
      attachValidation: true,
      schema: {
        tags: ['estoque'],
        summary: 'Atualizar item de estoque (ADMIN ou GERENTE)',
        description:
          'Atualiza um registro de estoque. **Perfil ADMIN ou GERENTE.**',
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
            quantidade_atual: { type: 'integer', minimum: 0 },
            ponto_reposicao: { type: 'integer', minimum: 0 },
          },
          minProperties: 1,
        },
        response: {
          200: estoqueResponseProps,
          400: { description: 'Payload invalido', ...errorResponseSchema },
          401: {
            description: 'Token invalido/ausente',
            ...errorResponseSchema,
          },
          403: { description: 'Perfil sem permissao', ...errorResponseSchema },
          404: {
            description: 'Estoque/unidade/produto nao encontrado',
            ...errorResponseSchema,
          },
          409: {
            description: 'Conflito de chave unica',
            ...errorResponseSchema,
          },
        },
      },
    },
    async (request, reply) => {
      if (request.validationError) {
        return reply.status(400).send(invalidEstoqueUpdatePayloadError())
      }

      if (!isAdminOuGerente(request)) {
        return reply.status(403).send(forbiddenError())
      }

      const paramsSchema = z.object({ id: z.string().uuid() })
      const bodySchema = z
        .object({
          unidade_id: z.string().uuid().optional(),
          produto_id: z.string().uuid().optional(),
          quantidade_atual: z.number().int().min(0).optional(),
          ponto_reposicao: z.number().int().min(0).optional(),
        })
        .refine(
          (d) =>
            d.unidade_id !== undefined ||
            d.produto_id !== undefined ||
            d.quantidade_atual !== undefined ||
            d.ponto_reposicao !== undefined,
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
        return reply.status(400).send(invalidEstoqueUpdatePayloadError())
      }

      const { id } = parsedParams.data
      const current = await db('estoque').where({ id }).first()
      if (!current) {
        return reply.status(404).send({
          error: 'NAO_ENCONTRADO',
          message: 'Estoque nao encontrado.',
        })
      }

      const nextUnidadeId = parsedBody.data.unidade_id ?? current.unidade_id
      const nextProdutoId = parsedBody.data.produto_id ?? current.produto_id

      const fkValidation = await validateForeignKeys(
        nextUnidadeId,
        nextProdutoId,
      )
      if (!fkValidation.ok) {
        return reply.status(404).send({
          error: 'NAO_ENCONTRADO',
          message: fkValidation.error,
        })
      }

      const duplicate = await db('estoque')
        .where({ unidade_id: nextUnidadeId, produto_id: nextProdutoId })
        .whereNot({ id })
        .first()

      if (duplicate) {
        return reply.status(409).send({
          error: 'CONFLITO',
          message:
            'Ja existe registro de estoque para este par unidade/produto.',
        })
      }

      const patch: Record<string, unknown> = {}
      if (parsedBody.data.unidade_id !== undefined)
        patch.unidade_id = parsedBody.data.unidade_id
      if (parsedBody.data.produto_id !== undefined)
        patch.produto_id = parsedBody.data.produto_id
      if (parsedBody.data.quantidade_atual !== undefined) {
        patch.quantidade_atual = parsedBody.data.quantidade_atual
      }
      if (parsedBody.data.ponto_reposicao !== undefined) {
        patch.ponto_reposicao = parsedBody.data.ponto_reposicao
      }

      await db('estoque').where({ id }).update(patch)

      const updated = await db('estoque')
        .select(
          'id',
          'unidade_id',
          'produto_id',
          'quantidade_atual',
          'ponto_reposicao',
        )
        .where({ id })
        .first()

      const actorId = getUsuarioIdFromRequest(request)
      if (actorId) {
        await registrarLogAuditoria(request.log, {
          usuarioId: actorId,
          acao: AcaoAuditoria.ESTOQUE_UPDATE,
          detalhes: JSON.stringify({
            estoque_id: id,
            campos: Object.keys(patch),
          }),
          ipOrigem: request.ip,
        })
      }

      return reply.status(200).send(updated)
    },
  )

  // Remove a linha de estoque (não apaga unidade nem produto, só o vínculo/quantidade)
  app.delete(
    '/estoque/:id',
    {
      preHandler: [authenticate],
      attachValidation: true,
      schema: {
        tags: ['estoque'],
        summary: 'Remover item de estoque (ADMIN ou GERENTE)',
        description:
          'Exclui um registro de estoque por id. **Perfil ADMIN ou GERENTE.**',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: {
          204: { description: 'Estoque removido' },
          400: { description: 'Id invalido', ...errorResponseSchema },
          401: {
            description: 'Token invalido/ausente',
            ...errorResponseSchema,
          },
          403: { description: 'Perfil sem permissao', ...errorResponseSchema },
          404: {
            description: 'Estoque nao encontrado',
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

      const deleted = await db('estoque').where({ id: parsed.data.id }).del()
      if (deleted === 0) {
        return reply.status(404).send({
          error: 'NAO_ENCONTRADO',
          message: 'Estoque nao encontrado.',
        })
      }

      const actorId = getUsuarioIdFromRequest(request)
      if (actorId) {
        await registrarLogAuditoria(request.log, {
          usuarioId: actorId,
          acao: AcaoAuditoria.ESTOQUE_DELETE,
          detalhes: JSON.stringify({ estoque_id: parsed.data.id }),
          ipOrigem: request.ip,
        })
      }

      return reply.status(204).send()
    },
  )
}
