import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { db } from '../database.js'
import {
  forbiddenError,
  invalidUnidadeCreationPayloadError,
  invalidUnidadeUpdatePayloadError,
} from '../http/errors.js'
import { authenticate } from '../middlewares/authenticate.js'
import { isAdminOuGerente } from '../authz/perfis.js'
import {
  AcaoAuditoria,
  getUsuarioIdFromRequest,
  registrarLogAuditoria,
} from '../services/audit-log.js'

// CRUD de unidades (filiais da rede).
// GET: qualquer um logado | POST/PUT/DELETE: ADMIN ou GERENTE

const errorResponseSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    message: { type: 'string' },
  },
  required: ['error', 'message'],
} as const

const unidadeResponseProps = {
  type: 'object',
  required: ['id', 'nome', 'endereco', 'tipo_cozinha', 'ativa'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    nome: { type: 'string' },
    endereco: { type: 'string' },
    tipo_cozinha: { type: 'string' },
    ativa: { type: 'boolean' },
  },
} as const

export async function unidadesRoutes(app: FastifyInstance) {
  // Lista unidades — dá pra filtrar por ativa=true ou ativa=false
  app.get(
    '/unidades',
    {
      preHandler: [authenticate],
      attachValidation: true,
      schema: {
        tags: ['unidades'],
        summary: 'Listar unidades',
        description:
          'Lista unidades da rede com paginacao. Opcionalmente filtra por ativa. **Qualquer perfil autenticado.**',
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
              description: 'Registros por pagina (maximo 100)',
            },
            ativa: {
              type: 'boolean',
              description: 'Se informado, filtra unidades ativas ou inativas',
            },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['data', 'page', 'limit', 'total'],
            properties: {
              data: { type: 'array', items: unidadeResponseProps },
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
            'Parametros invalidos. Use page >= 1, limit entre 1 e 100 e ativa booleana opcional.',
        })
      }

      const q = request.query as {
        page?: number
        limit?: number
        ativa?: boolean
      }
      const page = typeof q.page === 'number' && q.page >= 1 ? q.page : 1
      let limit = typeof q.limit === 'number' && q.limit >= 1 ? q.limit : 10
      if (limit > 100) limit = 100
      const offset = (page - 1) * limit

      let countQuery = db('unidades')
      let listQuery = db('unidades')
        .select('id', 'nome', 'endereco', 'tipo_cozinha', 'ativa')
        .orderBy('nome', 'asc')

      // Filtro opcional: só unidades ativas ou só inativas
      if (typeof q.ativa === 'boolean') {
        countQuery = countQuery.where({ ativa: q.ativa })
        listQuery = listQuery.where({ ativa: q.ativa })
      }

      const [countRow] = await countQuery.count('* as total')
      const total = Number((countRow as { total: string }).total ?? 0)

      const data = await listQuery.limit(limit).offset(offset)

      return reply.status(200).send({ data, page, limit, total })
    },
  )

  // Busca uma unidade pelo id (UUID na URL)
  app.get(
    '/unidades/:id',
    {
      preHandler: [authenticate],
      attachValidation: true,
      schema: {
        tags: ['unidades'],
        summary: 'Buscar unidade por id',
        description:
          'Retorna uma unidade pelo UUID. **Qualquer perfil autenticado.**',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
        response: {
          200: unidadeResponseProps,
          400: { description: 'Id invalido', ...errorResponseSchema },
          401: {
            description: 'Token invalido/ausente',
            ...errorResponseSchema,
          },
          404: {
            description: 'Unidade nao encontrada',
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

      const row = await db('unidades')
        .select('id', 'nome', 'endereco', 'tipo_cozinha', 'ativa')
        .where({ id: parsed.data.id })
        .first()

      if (!row) {
        return reply.status(404).send({
          error: 'NAO_ENCONTRADO',
          message: 'Unidade nao encontrada.',
        })
      }

      return reply.status(200).send(row)
    },
  )

  // Cria unidade nova — precisa ser ADMIN ou GERENTE
  app.post(
    '/unidades',
    {
      preHandler: [authenticate],
      attachValidation: true,
      schema: {
        tags: ['unidades'],
        summary: 'Criar unidade (ADMIN ou GERENTE)',
        description:
          'Cadastra uma nova unidade da rede. **Perfil ADMIN ou GERENTE.**',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['nome', 'endereco', 'tipo_cozinha'],
          properties: {
            nome: { type: 'string', minLength: 1 },
            endereco: { type: 'string', minLength: 1 },
            tipo_cozinha: { type: 'string', minLength: 1 },
            ativa: { type: 'boolean' },
          },
        },
        response: {
          201: unidadeResponseProps,
          400: { description: 'Payload invalido', ...errorResponseSchema },
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
        return reply.status(400).send(invalidUnidadeCreationPayloadError())
      }

      if (!isAdminOuGerente(request)) {
        return reply.status(403).send(forbiddenError())
      }

      // Zod valida de novo no código (além do schema do Swagger)
      const bodySchema = z.object({
        nome: z.string().trim().min(1),
        endereco: z.string().trim().min(1),
        tipo_cozinha: z.string().trim().min(1),
        ativa: z.boolean().optional(),
      })

      const parsedBody = bodySchema.safeParse(request.body)
      if (!parsedBody.success) {
        return reply.status(400).send(invalidUnidadeCreationPayloadError())
      }

      const { nome, endereco, tipo_cozinha, ativa } = parsedBody.data
      const id = randomUUID()

      await db('unidades').insert({
        id,
        nome,
        endereco,
        tipo_cozinha,
        ativa: ativa ?? true,
      })

      const created = await db('unidades')
        .select('id', 'nome', 'endereco', 'tipo_cozinha', 'ativa')
        .where({ id })
        .first()

      const actorId = getUsuarioIdFromRequest(request)
      if (actorId) {
        await registrarLogAuditoria(request.log, {
          usuarioId: actorId,
          acao: AcaoAuditoria.UNIDADE_CREATE,
          detalhes: JSON.stringify({ unidade_id: id }),
          ipOrigem: request.ip,
        })
      }

      return reply.status(201).send(created!)
    },
  )

  // Atualização parcial — manda só o que quer mudar
  app.put(
    '/unidades/:id',
    {
      preHandler: [authenticate],
      attachValidation: true,
      schema: {
        tags: ['unidades'],
        summary: 'Atualizar unidade (ADMIN ou GERENTE)',
        description:
          'Atualiza dados de uma unidade. **Perfil ADMIN ou GERENTE.**',
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
            endereco: { type: 'string', minLength: 1 },
            tipo_cozinha: { type: 'string', minLength: 1 },
            ativa: { type: 'boolean' },
          },
          minProperties: 1,
        },
        response: {
          200: unidadeResponseProps,
          400: { description: 'Payload invalido', ...errorResponseSchema },
          401: {
            description: 'Token invalido/ausente',
            ...errorResponseSchema,
          },
          403: { description: 'Perfil sem permissao', ...errorResponseSchema },
          404: {
            description: 'Unidade nao encontrada',
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
            'Dados de atualizacao invalidos. Informe ao menos um campo valido para atualizar.',
        })
      }

      if (!isAdminOuGerente(request)) {
        return reply.status(403).send(forbiddenError())
      }

      const paramsSchema = z.object({ id: z.string().uuid() })
      const bodySchema = z
        .object({
          nome: z.string().trim().min(1).optional(),
          endereco: z.string().trim().min(1).optional(),
          tipo_cozinha: z.string().trim().min(1).optional(),
          ativa: z.boolean().optional(),
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
        return reply.status(400).send(invalidUnidadeUpdatePayloadError())
      }

      const { id } = parsedParams.data
      const patch = parsedBody.data

      const target = await db('unidades').where({ id }).first()
      if (!target) {
        return reply.status(404).send({
          error: 'NAO_ENCONTRADO',
          message: 'Unidade nao encontrada.',
        })
      }

      await db('unidades').where({ id }).update(patch)

      const updated = await db('unidades')
        .select('id', 'nome', 'endereco', 'tipo_cozinha', 'ativa')
        .where({ id })
        .first()

      const actorId = getUsuarioIdFromRequest(request)
      if (actorId) {
        await registrarLogAuditoria(request.log, {
          usuarioId: actorId,
          acao: AcaoAuditoria.UNIDADE_UPDATE,
          detalhes: JSON.stringify({
            unidade_id: id,
            campos: Object.keys(patch),
          }),
          ipOrigem: request.ip,
        })
      }

      return reply.status(200).send(updated!)
    },
  )

  // Não deixa apagar se ainda tiver pedido ligado nessa unidade (migration RESTRICT)
  app.delete(
    '/unidades/:id',
    {
      preHandler: [authenticate],
      attachValidation: true,
      schema: {
        tags: ['unidades'],
        summary: 'Remover unidade (ADMIN ou GERENTE)',
        description:
          'Exclui uma unidade. Nao permitido se existirem pedidos vinculados (RESTRICT). **Perfil ADMIN ou GERENTE.**',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
        response: {
          204: { description: 'Unidade removida' },
          400: { description: 'Id invalido', ...errorResponseSchema },
          401: {
            description: 'Token invalido/ausente',
            ...errorResponseSchema,
          },
          403: { description: 'Perfil sem permissao', ...errorResponseSchema },
          404: {
            description: 'Unidade nao encontrada',
            ...errorResponseSchema,
          },
          409: {
            description: 'Existem pedidos vinculados',
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
      const parsedParams = paramsSchema.safeParse(request.params)
      if (!parsedParams.success) {
        return reply.status(400).send({
          error: 'DADOS_INVALIDOS',
          message: 'O id na URL deve ser um UUID valido.',
        })
      }

      const { id } = parsedParams.data

      const exists = await db('unidades').where({ id }).first()
      if (!exists) {
        return reply.status(404).send({
          error: 'NAO_ENCONTRADO',
          message: 'Unidade nao encontrada.',
        })
      }

      // Conta pedidos dessa unidade antes de excluir
      const [pedRow] = await db('pedidos')
        .where({ unidade_id: id })
        .count('* as total')
      const pedidosVinculados = Number((pedRow as { total: string }).total ?? 0)
      if (pedidosVinculados > 0) {
        return reply.status(409).send({
          error: 'CONFLITO',
          message:
            'Nao e possivel excluir: existem pedidos vinculados a esta unidade.',
        })
      }

      await db('unidades').where({ id }).del()

      const actorId = getUsuarioIdFromRequest(request)
      if (actorId) {
        await registrarLogAuditoria(request.log, {
          usuarioId: actorId,
          acao: AcaoAuditoria.UNIDADE_DELETE,
          detalhes: JSON.stringify({ unidade_id: id }),
          ipOrigem: request.ip,
        })
      }

      return reply.status(204).send()
    },
  )
}
