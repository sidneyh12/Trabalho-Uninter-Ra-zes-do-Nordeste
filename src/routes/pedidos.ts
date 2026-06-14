/**
 * Rotas de pedidos (`/pedidos`).
 *
 * Contexto no dominio Raizes do Nordeste:
 * - Tabela `pedidos`: cabecalho (cliente, unidade, canal multicanal, status, valor total).
 * - Tabela `itens_pedido`: linhas do pedido com preco congelado (`preco_unitario_no_momento`).
 * - Requisito do roteiro: campo `canalPedido` obrigatorio na criacao (APP, TOTEM, etc.).
 *
 * Fluxo de estoque:
 * - Na criacao (POST), baixa-se `estoque.quantidade_atual` na unidade para cada produto.
 * - Ao cancelar (PUT status CANCELADO), devolve-se quantidade ao estoque.
 * - Ao excluir (DELETE) pedido ainda em AGUARDANDO_PAGAMENTO, restaura-se estoque antes de apagar
 *   (porque a baixa ja tinha ocorrido na criacao). Pedido CANCELADO ja teve estoque devolvido no PUT.
 *
 * Autorizacao resumida:
 * - Listagem/detalhe: CLIENTE ve so seus pedidos; ADMIN e GERENTE veem todos;
 *   COZINHA/BALCAO veem pedidos da `unidade_vinculada_id` do usuario (definida pelo ADMIN).
 * - Criacao: qualquer usuario logado; `cliente_id` no body apenas se ADMIN (pedido em nome de outro usuario).
 * - Atualizacao de status: equipe (COZINHA, BALCAO, etc.) e ADMIN; cliente pode cancelar o proprio em AGUARDANDO_PAGAMENTO.
 * - DELETE: somente ADMIN, com restricoes de status e ausencia de pagamento.
 */
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { z } from 'zod'

import { db } from '../database.js'
import {
  forbiddenError,
  invalidPedidoCreationPayloadError,
  invalidPedidoUpdatePayloadError,
} from '../http/errors.js'
import { authenticate } from '../middlewares/authenticate.js'
import {
  AcaoAuditoria,
  getUsuarioIdFromRequest,
  registrarLogAuditoria,
} from '../services/audit-log.js'

/** Padrao minimo de erro na documentacao OpenAPI (alinhado ao restante da API). */
const errorResponseSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    message: { type: 'string' },
  },
  required: ['error', 'message'],
} as const

/**
 * Canais de origem do pedido (multicanalidade) — espelha o ENUM da migration `pedidos.canalPedido`.
 * Obrigatorio no POST para rastreabilidade (app, totem, balcao, etc.).
 */
const CANAIS = ['APP', 'TOTEM', 'BALCAO', 'PICKUP', 'WEB'] as const

/**
 * Estados do pedido ao longo da operacao.
 * - AGUARDANDO_PAGAMENTO: criacao; estoque ja foi baixado (MVP ate integrar pagamento mock).
 * - EM_PREPARO / PRONTO / ENTREGUE: fluxo cozinha/retirada.
 * - CANCELADO: estoque devolvido na transicao para este status.
 */
const STATUS = [
  'AGUARDANDO_PAGAMENTO',
  'EM_PREPARO',
  'PRONTO',
  'ENTREGUE',
  'CANCELADO',
] as const
type StatusPedido = (typeof STATUS)[number]

/** Schema Swagger: uma linha de item retornada em GET detalhe / POST 201. */
const itemPedidoResponseProps = {
  type: 'object',
  required: ['id', 'produto_id', 'quantidade', 'preco_unitario_no_momento'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    produto_id: { type: 'string', format: 'uuid' },
    quantidade: { type: 'integer' },
    preco_unitario_no_momento: { type: 'number' },
  },
} as const

/** Schema Swagger: pedido na listagem (sem array de itens — evita payload pesado na lista). */
const pedidoResponseProps = {
  type: 'object',
  required: [
    'id',
    'cliente_id',
    'unidade_id',
    'canalPedido',
    'status',
    'valor_total',
    'valor_desconto',
    'criado_em',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    cliente_id: { type: 'string', format: 'uuid' },
    unidade_id: { type: 'string', format: 'uuid' },
    canalPedido: { type: 'string', enum: [...CANAIS] },
    status: { type: 'string' },
    valor_total: { type: 'number' },
    valor_desconto: { type: 'number' },
    campanha_id: { type: ['string', 'null'], format: 'uuid' },
    criado_em: { type: 'string', format: 'date-time' },
  },
} as const

/** Schema Swagger: pedido completo com `itens` (GET por id, POST criacao, PUT atualizacao). */
const pedidoDetalheResponseProps = {
  type: 'object',
  required: [
    'id',
    'cliente_id',
    'unidade_id',
    'canalPedido',
    'status',
    'valor_total',
    'valor_desconto',
    'criado_em',
    'itens',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    cliente_id: { type: 'string', format: 'uuid' },
    unidade_id: { type: 'string', format: 'uuid' },
    canalPedido: { type: 'string', enum: [...CANAIS] },
    status: { type: 'string' },
    valor_total: { type: 'number' },
    valor_desconto: { type: 'number' },
    campanha_id: { type: ['string', 'null'], format: 'uuid' },
    criado_em: { type: 'string', format: 'date-time' },
    itens: { type: 'array', items: itemPedidoResponseProps },
  },
} as const

/** Token JWT carrega `perfil` (ver rota de login); usado para autorizacao de escrita/exclusao. */
function isAdmin(request: { user?: unknown }): boolean {
  const authUser = request.user as { perfil?: string } | undefined
  return authUser?.perfil === 'ADMIN'
}

/**
 * Identificador do usuario no JWT (`sub` = id em `usuarios`).
 * Usado como cliente padrao do pedido quando nao e ADMIN com `cliente_id` no body.
 */
function getSub(request: { user?: unknown }): string | undefined {
  return (request.user as { sub?: string } | undefined)?.sub
}

/** Visao ampla de pedidos na listagem e no detalhe de terceiros. */
function podeVerTodosPedidos(request: { user?: unknown }): boolean {
  const p = (request.user as { perfil?: string } | undefined)?.perfil
  return p === 'ADMIN' || p === 'GERENTE'
}

/** Pode avancar status operacional (cozinha/pronto) ou cancelar em estados permitidos pela regra de negocio. */
function podeAtualizarStatusOperacional(request: { user?: unknown }): boolean {
  const p = (request.user as { perfil?: string } | undefined)?.perfil
  return p === 'ADMIN' || p === 'GERENTE' || p === 'COZINHA' || p === 'BALCAO'
}

function perfilCozinhaBalcao(perfil: string | undefined): boolean {
  return perfil === 'COZINHA' || perfil === 'BALCAO'
}

/** COZINHA/BALCAO enxergam pedido da mesma unidade vinculada ao usuario operacional. */
async function podeAcessarPedidoPorPerfil(
  request: { user?: unknown },
  pedido: Record<string, unknown>,
  sub: string,
): Promise<boolean> {
  if (podeVerTodosPedidos(request)) return true
  if (String(pedido.cliente_id) === sub) return true
  const perfil = (request.user as { perfil?: string } | undefined)?.perfil
  if (!perfilCozinhaBalcao(perfil)) return false
  const usr = await db('usuarios')
    .select('unidade_vinculada_id')
    .where({ id: sub })
    .first()
  if (!usr?.unidade_vinculada_id) return false
  return String(pedido.unidade_id) === String(usr.unidade_vinculada_id)
}

/** Normaliza tipos do banco (decimal, Date) para JSON estavel na API. */
function serializePedido(row: Record<string, unknown>) {
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

/** Inteiros e decimais podem vir como string dependendo do driver SQL. */
function serializeItem(row: Record<string, unknown>) {
  return {
    id: row.id,
    produto_id: row.produto_id,
    quantidade: Number(row.quantidade),
    preco_unitario_no_momento: Number(row.preco_unitario_no_momento),
  }
}

/**
 * Grafo de transicoes de status (maquina de estados simples).
 * Evita saltos invalidos (ex.: ENTREGUE -> EM_PREPARO) e documenta o fluxo esperado.
 */
const transicoesPermitidas: Record<StatusPedido, StatusPedido[]> = {
  AGUARDANDO_PAGAMENTO: ['EM_PREPARO', 'CANCELADO'],
  EM_PREPARO: ['PRONTO', 'CANCELADO'],
  PRONTO: ['ENTREGUE'],
  ENTREGUE: [],
  CANCELADO: [],
}

/** Verifica se a mudanca `atual` -> `novo` esta no mapa `transicoesPermitidas`. */
function transicaoValida(atual: string, novo: StatusPedido): boolean {
  const permitidos = transicoesPermitidas[atual as StatusPedido]
  return permitidos?.includes(novo) ?? false
}

/** Busca linhas em `itens_pedido` para montar resposta detalhada. */
async function carregarItensPedido(pedidoId: string) {
  const rows = await db('itens_pedido')
    .select('id', 'produto_id', 'quantidade', 'preco_unitario_no_momento')
    .where({ pedido_id: pedidoId })
    .orderBy('id', 'asc')
  return rows.map((r) => serializeItem(r as Record<string, unknown>))
}

/**
 * Soma de volta `quantidade_atual` em `estoque` para cada produto da unidade.
 * Usado em: cancelamento de pedido (PUT), exclusao de pedido ainda aguardando pagamento (DELETE).
 * Roda dentro de transacao (`trx`) para manter consistencia com atualizacao do pedido.
 */
async function restaurarEstoque(
  trx: Knex.Transaction,
  unidadeId: string,
  itens: { produto_id: string; quantidade: number }[],
) {
  for (const it of itens) {
    const est = await trx('estoque')
      .where({ unidade_id: unidadeId, produto_id: it.produto_id })
      .first()
    if (est) {
      await trx('estoque')
        .where({ id: est.id })
        .update({
          quantidade_atual: Number(est.quantidade_atual) + it.quantidade,
        })
    }
  }
}

export async function pedidosRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /pedidos — listagem paginada com filtros e visao por perfil
  // ---------------------------------------------------------------------------
  app.get(
    '/pedidos',
    {
      preHandler: [authenticate],
      attachValidation: true,
      schema: {
        tags: ['pedidos'],
        summary: 'Listar pedidos',
        description:
          'Lista pedidos com paginacao. CLIENTE ve apenas os proprios. ADMIN/GERENTE veem todos. COZINHA/BALCAO veem pedidos da unidade (`unidade_vinculada_id` no cadastro do usuario). Filtros opcionais.',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
            unidade_id: { type: 'string', format: 'uuid' },
            cliente_id: { type: 'string', format: 'uuid' },
            canalPedido: { type: 'string', enum: [...CANAIS] },
            status: { type: 'string' },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['data', 'page', 'limit', 'total'],
            properties: {
              data: { type: 'array', items: pedidoResponseProps },
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
          403: {
            description:
              'Sem permissao ou unidade nao vinculada ao perfil operacional',
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

      // Query params tipados (Fastify + coerceTypes converte strings numericas onde aplicavel).
      const q = request.query as {
        page?: number
        limit?: number
        unidade_id?: string
        cliente_id?: string
        canalPedido?: string
        status?: string
      }

      const page = typeof q.page === 'number' && q.page >= 1 ? q.page : 1
      let limit = typeof q.limit === 'number' && q.limit >= 1 ? q.limit : 10
      if (limit > 100) limit = 100
      const offset = (page - 1) * limit

      // Sem `sub` o JWT nao bate com o payload esperado (login deve preencher `sub`).
      const sub = getSub(request)
      if (!sub) {
        return reply.status(401).send({
          error: 'NAO_AUTORIZADO',
          message: 'Token invalido.',
        })
      }

      let countQuery = db('pedidos')
      let listQuery = db('pedidos')
        .select(
          'id',
          'cliente_id',
          'unidade_id',
          'canalPedido',
          'status',
          'valor_total',
          'valor_desconto',
          'campanha_id',
          'criado_em',
        )
        .orderBy('criado_em', 'desc')

      const perfil = (request.user as { perfil?: string } | undefined)?.perfil

      if (podeVerTodosPedidos(request)) {
        if (q.cliente_id) {
          countQuery = countQuery.where({ cliente_id: q.cliente_id })
          listQuery = listQuery.where({ cliente_id: q.cliente_id })
        }
      } else if (perfilCozinhaBalcao(perfil)) {
        const usr = await db('usuarios')
          .select('unidade_vinculada_id')
          .where({ id: sub })
          .first()
        if (!usr?.unidade_vinculada_id) {
          return reply.status(403).send({
            error: 'CONFIG_INCOMPLETA',
            message:
              'Perfil COZINHA ou BALCAO precisa ter unidade_vinculada_id definida pelo ADMIN para listar a fila da unidade.',
          })
        }
        const uid = String(usr.unidade_vinculada_id)
        countQuery = countQuery.where({ unidade_id: uid })
        listQuery = listQuery.where({ unidade_id: uid })
        if (q.cliente_id) {
          countQuery = countQuery.where({ cliente_id: q.cliente_id })
          listQuery = listQuery.where({ cliente_id: q.cliente_id })
        }
      } else {
        countQuery = countQuery.where({ cliente_id: sub })
        listQuery = listQuery.where({ cliente_id: sub })
      }

      // Filtros opcionais aplicados a qualquer consulta ja restrita acima.
      if (q.unidade_id) {
        countQuery = countQuery.where({ unidade_id: q.unidade_id })
        listQuery = listQuery.where({ unidade_id: q.unidade_id })
      }
      if (q.canalPedido) {
        countQuery = countQuery.where({ canalPedido: q.canalPedido })
        listQuery = listQuery.where({ canalPedido: q.canalPedido })
      }
      if (q.status) {
        countQuery = countQuery.where({ status: q.status })
        listQuery = listQuery.where({ status: q.status })
      }

      // Impede CLIENTE (e perfis equivalentes a visao "so meus") de usar `cliente_id` para espiar terceiros.
      if (
        !podeVerTodosPedidos(request) &&
        !perfilCozinhaBalcao(perfil) &&
        q.cliente_id &&
        q.cliente_id !== sub
      ) {
        return reply.status(403).send(forbiddenError())
      }

      const [countRow] = await countQuery.count('* as total')
      const total = Number((countRow as { total: string }).total ?? 0)
      const rows = await listQuery.limit(limit).offset(offset)
      const data = rows.map((r) =>
        serializePedido(r as Record<string, unknown>),
      )

      return reply.status(200).send({ data, page, limit, total })
    },
  )

  // ---------------------------------------------------------------------------
  // GET /pedidos/:id — detalhe com itens; isolamento por cliente
  // ---------------------------------------------------------------------------
  app.get(
    '/pedidos/:id',
    {
      preHandler: [authenticate],
      attachValidation: true,
      schema: {
        tags: ['pedidos'],
        summary: 'Buscar pedido por id',
        description:
          'Retorna pedido com itens. CLIENTE so o proprio; COZINHA/BALCAO podem ler pedidos da sua unidade_vinculada_id.',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: {
          200: pedidoDetalheResponseProps,
          400: { description: 'Id invalido', ...errorResponseSchema },
          401: {
            description: 'Token invalido/ausente',
            ...errorResponseSchema,
          },
          403: { description: 'Sem permissao', ...errorResponseSchema },
          404: { description: 'Pedido nao encontrado', ...errorResponseSchema },
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

      const sub = getSub(request)
      if (!sub) {
        return reply.status(401).send({
          error: 'NAO_AUTORIZADO',
          message: 'Token invalido.',
        })
      }

      const row = await db('pedidos')
        .select(
          'id',
          'cliente_id',
          'unidade_id',
          'canalPedido',
          'status',
          'valor_total',
          'valor_desconto',
          'campanha_id',
          'criado_em',
        )
        .where({ id: parsed.data.id })
        .first()

      if (!row) {
        return reply.status(404).send({
          error: 'NAO_ENCONTRADO',
          message: 'Pedido nao encontrado.',
        })
      }

      const pedido = row as Record<string, unknown>
      if (!(await podeAcessarPedidoPorPerfil(request, pedido, sub))) {
        return reply.status(403).send(forbiddenError())
      }

      const itens = await carregarItensPedido(parsed.data.id)

      return reply.status(200).send({
        ...serializePedido(pedido),
        itens,
      })
    },
  )

  // ---------------------------------------------------------------------------
  // POST /pedidos — criacao com validacao de estoque e transacao atomica
  // ---------------------------------------------------------------------------
  app.post(
    '/pedidos',
    {
      preHandler: [authenticate],
      attachValidation: true,
      schema: {
        tags: ['pedidos'],
        summary: 'Criar pedido',
        description:
          '**Qualquer perfil autenticado.** Cria pedido com itens, baixa estoque. `canalPedido` obrigatorio; opcional `campanha_id`. **Somente ADMIN** pode enviar `cliente_id` (pedido para terceiro).',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['unidade_id', 'canalPedido', 'itens'],
          properties: {
            unidade_id: { type: 'string', format: 'uuid' },
            cliente_id: { type: 'string', format: 'uuid' },
            campanha_id: { type: 'string', format: 'uuid' },
            canalPedido: { type: 'string', enum: [...CANAIS] },
            itens: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                required: ['produto_id', 'quantidade'],
                properties: {
                  produto_id: { type: 'string', format: 'uuid' },
                  quantidade: { type: 'integer', minimum: 1 },
                },
              },
            },
          },
        },
        response: {
          201: pedidoDetalheResponseProps,
          400: { description: 'Payload invalido', ...errorResponseSchema },
          401: {
            description: 'Token invalido/ausente',
            ...errorResponseSchema,
          },
          404: {
            description: 'Recurso nao encontrado',
            ...errorResponseSchema,
          },
          409: { description: 'Estoque insuficiente', ...errorResponseSchema },
        },
      },
    },
    async (request, reply) => {
      if (request.validationError) {
        return reply.status(400).send(invalidPedidoCreationPayloadError())
      }

      const sub = getSub(request)
      if (!sub) {
        return reply.status(401).send({
          error: 'NAO_AUTORIZADO',
          message: 'Token invalido.',
        })
      }

      const bodySchema = z.object({
        unidade_id: z.string().uuid(),
        cliente_id: z.string().uuid().optional(),
        campanha_id: z.string().uuid().optional(),
        canalPedido: z.enum(CANAIS),
        itens: z
          .array(
            z.object({
              produto_id: z.string().uuid(),
              quantidade: z.number().int().min(1),
            }),
          )
          .min(1),
      })

      const parsed = bodySchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send(invalidPedidoCreationPayloadError())
      }

      // Quem "compra": por padrao o usuario do token; ADMIN pode registrar pedido para outro `cliente_id`.
      const clienteId =
        isAdmin(request) && parsed.data.cliente_id
          ? parsed.data.cliente_id
          : sub

      const usuario = await db('usuarios')
        .select('id')
        .where({ id: clienteId })
        .first()
      if (!usuario) {
        return reply.status(404).send({
          error: 'NAO_ENCONTRADO',
          message: 'Cliente nao encontrado.',
        })
      }

      const unidade = await db('unidades')
        .select('id')
        .where({ id: parsed.data.unidade_id })
        .first()
      if (!unidade) {
        return reply.status(404).send({
          error: 'NAO_ENCONTRADO',
          message: 'Unidade nao encontrada.',
        })
      }

      // Agrupa quantidades por produto (evita duas linhas no mesmo produto no mesmo request).
      const merged = new Map<string, number>()
      for (const it of parsed.data.itens) {
        merged.set(
          it.produto_id,
          (merged.get(it.produto_id) ?? 0) + it.quantidade,
        )
      }

      const linhas: {
        produto_id: string
        quantidade: number
        preco_unitario: number
      }[] = []
      let valorTotal = 0

      // Para cada produto: existe cadastro, existe estoque na unidade, quantidade suficiente, preco atual.
      for (const [produtoId, quantidade] of merged) {
        const produto = await db('produtos')
          .select('id', 'preco_base')
          .where({ id: produtoId })
          .first()
        if (!produto) {
          return reply.status(404).send({
            error: 'NAO_ENCONTRADO',
            message: `Produto nao encontrado: ${produtoId}.`,
          })
        }

        const est = await db('estoque')
          .where({ unidade_id: parsed.data.unidade_id, produto_id: produtoId })
          .first()

        if (!est) {
          return reply.status(404).send({
            error: 'NAO_ENCONTRADO',
            message: 'Produto sem estoque cadastrado para esta unidade.',
          })
        }

        const qAtual = Number(est.quantidade_atual)
        if (qAtual < quantidade) {
          return reply.status(409).send({
            error: 'ESTOQUE_INSUFICIENTE',
            message: `Estoque insuficiente para o produto ${produtoId}. Disponivel: ${qAtual}.`,
          })
        }

        const precoUnit = Number(produto.preco_base)
        valorTotal += precoUnit * quantidade
        linhas.push({
          produto_id: produtoId,
          quantidade,
          preco_unitario: precoUnit,
        })
      }

      let valorDesconto = 0
      let campanhaId: string | null = null
      if (parsed.data.campanha_id) {
        const camp = await db('campanhas')
          .where({ id: parsed.data.campanha_id })
          .first()
        if (!camp) {
          return reply.status(404).send({
            error: 'NAO_ENCONTRADO',
            message: 'Campanha nao encontrada.',
          })
        }
        if (!(camp as { ativa?: boolean }).ativa) {
          return reply.status(409).send({
            error: 'CONFLITO',
            message: 'Campanha inativa.',
          })
        }
        const now = new Date()
        const vde = new Date(
          (camp as { valido_de: Date | string }).valido_de instanceof Date
            ? (camp as { valido_de: Date }).valido_de.toISOString()
            : String((camp as { valido_de: string }).valido_de),
        )
        const vat = new Date(
          (camp as { valido_ate: Date | string }).valido_ate instanceof Date
            ? (camp as { valido_ate: Date }).valido_ate.toISOString()
            : String((camp as { valido_ate: string }).valido_ate),
        )
        if (now < vde || now > vat) {
          return reply.status(409).send({
            error: 'CONFLITO',
            message: 'Campanha fora do periodo de vigencia.',
          })
        }
        const cUnid = (camp as { unidade_id?: string | null }).unidade_id
        if (cUnid != null && String(cUnid) !== parsed.data.unidade_id) {
          return reply.status(409).send({
            error: 'CONFLITO',
            message: 'Campanha nao se aplica a esta unidade.',
          })
        }
        const pct = Number(
          (camp as { percentual_desconto: unknown }).percentual_desconto,
        )
        valorDesconto = Math.round(((valorTotal * pct) / 100) * 100) / 100
        campanhaId = String((camp as { id: string }).id)
      }

      const valorFinal = Math.max(
        0,
        Math.round((valorTotal - valorDesconto) * 100) / 100,
      )

      const pedidoId = randomUUID()

      try {
        // Tudo ou nada: insere pedido + itens e baixa estoque; falha em qualquer passo desfaz o lote.
        await db.transaction(async (trx) => {
          await trx('pedidos').insert({
            id: pedidoId,
            cliente_id: clienteId,
            unidade_id: parsed.data.unidade_id,
            canalPedido: parsed.data.canalPedido,
            status: 'AGUARDANDO_PAGAMENTO',
            valor_total: valorFinal,
            valor_desconto: valorDesconto,
            campanha_id: campanhaId,
            criado_em: trx.fn.now(),
          })

          for (const linha of linhas) {
            // `preco_unitario_no_momento` congela o preco para historico mesmo se `produtos.preco_base` mudar depois.
            await trx('itens_pedido').insert({
              id: randomUUID(),
              pedido_id: pedidoId,
              produto_id: linha.produto_id,
              quantidade: linha.quantidade,
              preco_unitario_no_momento: linha.preco_unitario,
            })

            // Rele o estoque dentro da transacao (par unidade+produto ja validado antes, mas garantimos consistencia).
            const est = await trx('estoque')
              .where({
                unidade_id: parsed.data.unidade_id,
                produto_id: linha.produto_id,
              })
              .first()

            if (!est) {
              throw new Error('ESTOQUE_INCONSISTENTE')
            }

            const novo = Number(est.quantidade_atual) - linha.quantidade
            await trx('estoque')
              .where({ id: est.id })
              .update({ quantidade_atual: novo })
          }
        })
      } catch (e) {
        // Erro controlado para responder 409 em vez de 500 se a linha de estoque sumir entre validacao e update.
        if (String(e).includes('ESTOQUE_INCONSISTENTE')) {
          return reply.status(409).send({
            error: 'CONFLITO',
            message: 'Inconsistencia ao atualizar estoque.',
          })
        }
        throw e
      }

      const created = await db('pedidos')
        .select(
          'id',
          'cliente_id',
          'unidade_id',
          'canalPedido',
          'status',
          'valor_total',
          'valor_desconto',
          'campanha_id',
          'criado_em',
        )
        .where({ id: pedidoId })
        .first()

      const itens = await carregarItensPedido(pedidoId)

      const actorPedido = getUsuarioIdFromRequest(request)
      if (actorPedido) {
        await registrarLogAuditoria(request.log, {
          usuarioId: actorPedido,
          acao: AcaoAuditoria.PEDIDO_CREATE,
          detalhes: JSON.stringify({
            pedido_id: pedidoId,
            cliente_id: clienteId,
            unidade_id: parsed.data.unidade_id,
            canalPedido: parsed.data.canalPedido,
            valor_bruto_itens: valorTotal,
            valor_desconto: valorDesconto,
            valor_total: valorFinal,
            campanha_id: campanhaId,
          }),
          ipOrigem: request.ip,
        })
      }

      return reply.status(201).send({
        ...serializePedido(created as Record<string, unknown>),
        itens,
      })
    },
  )

  // ---------------------------------------------------------------------------
  // PUT /pedidos/:id — mudanca de status (e cancelamento com devolucao de estoque)
  // ---------------------------------------------------------------------------
  app.put(
    '/pedidos/:id',
    {
      preHandler: [authenticate],
      attachValidation: true,
      schema: {
        tags: ['pedidos'],
        summary: 'Atualizar status do pedido',
        description:
          'Atualiza status com transicoes validas. CANCELADO restaura estoque. Perfis operacionais ou cancelamento pelo proprio cliente em AGUARDANDO_PAGAMENTO.',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          required: ['status'],
          properties: {
            status: { type: 'string', enum: [...STATUS] },
          },
        },
        response: {
          200: pedidoDetalheResponseProps,
          400: { description: 'Payload invalido', ...errorResponseSchema },
          401: {
            description: 'Token invalido/ausente',
            ...errorResponseSchema,
          },
          403: { description: 'Sem permissao', ...errorResponseSchema },
          404: { description: 'Pedido nao encontrado', ...errorResponseSchema },
          409: { description: 'Transicao invalida', ...errorResponseSchema },
        },
      },
    },
    async (request, reply) => {
      if (request.validationError) {
        return reply.status(400).send(invalidPedidoUpdatePayloadError())
      }

      const paramsSchema = z.object({ id: z.string().uuid() })
      const bodySchema = z.object({
        status: z.enum(STATUS),
      })

      const pp = paramsSchema.safeParse(request.params)
      const pb = bodySchema.safeParse(request.body)
      if (!pp.success) {
        return reply.status(400).send({
          error: 'DADOS_INVALIDOS',
          message: 'O id na URL deve ser um UUID valido.',
        })
      }
      if (!pb.success) {
        return reply.status(400).send(invalidPedidoUpdatePayloadError())
      }

      const sub = getSub(request)
      if (!sub) {
        return reply.status(401).send({
          error: 'NAO_AUTORIZADO',
          message: 'Token invalido.',
        })
      }

      const pedidoRow = await db('pedidos').where({ id: pp.data.id }).first()
      if (!pedidoRow) {
        return reply.status(404).send({
          error: 'NAO_ENCONTRADO',
          message: 'Pedido nao encontrado.',
        })
      }

      const pedido = pedidoRow as Record<string, unknown>
      const atual = String(pedido.status)
      const novo = pb.data.status

      if (!(await podeAcessarPedidoPorPerfil(request, pedido, sub))) {
        return reply.status(403).send(forbiddenError())
      }

      // Idempotencia simples: mesmo status de volta sem erro.
      if (novo === atual) {
        const itens = await carregarItensPedido(pp.data.id)
        return reply.status(200).send({
          ...serializePedido(pedido),
          itens,
        })
      }

      // Regras de quem pode mudar para CANCELADO vs avancar fluxo operacional.
      if (novo === 'CANCELADO') {
        const podeClienteCancelar =
          pedido.cliente_id === sub &&
          atual === 'AGUARDANDO_PAGAMENTO' &&
          (request.user as { perfil?: string }).perfil === 'CLIENTE'

        const podeStaffCancelar =
          podeAtualizarStatusOperacional(request) &&
          (atual === 'AGUARDANDO_PAGAMENTO' || atual === 'EM_PREPARO')

        if (!podeClienteCancelar && !podeStaffCancelar && !isAdmin(request)) {
          return reply.status(403).send(forbiddenError())
        }
      } else {
        // Avancar preparo / entrega: somente perfis operacionais ou ADMIN.
        if (!podeAtualizarStatusOperacional(request) && !isAdmin(request)) {
          return reply.status(403).send(forbiddenError())
        }
      }

      if (!transicaoValida(atual, novo)) {
        return reply.status(409).send({
          error: 'TRANSICAO_INVALIDA',
          message: `Nao e possivel alterar de "${atual}" para "${novo}".`,
        })
      }

      // Cancelamento: devolve ao estoque as quantidades que tinham sido baixadas na criacao.
      if (novo === 'CANCELADO') {
        const itensRows = await db('itens_pedido')
          .select('produto_id', 'quantidade')
          .where({ pedido_id: pp.data.id })

        await db.transaction(async (trx) => {
          await trx('pedidos')
            .where({ id: pp.data.id })
            .update({ status: novo })
          await restaurarEstoque(
            trx,
            String(pedido.unidade_id),
            itensRows.map((r) => ({
              produto_id: String(r.produto_id),
              quantidade: Number(r.quantidade),
            })),
          )
        })
      } else {
        // Transicao que nao cancela: apenas atualiza o status do pedido.
        await db('pedidos').where({ id: pp.data.id }).update({ status: novo })
      }

      const updated = await db('pedidos')
        .select(
          'id',
          'cliente_id',
          'unidade_id',
          'canalPedido',
          'status',
          'valor_total',
          'valor_desconto',
          'campanha_id',
          'criado_em',
        )
        .where({ id: pp.data.id })
        .first()

      const itens = await carregarItensPedido(pp.data.id)

      const actorStatus = getUsuarioIdFromRequest(request)
      if (actorStatus) {
        await registrarLogAuditoria(request.log, {
          usuarioId: actorStatus,
          acao: AcaoAuditoria.PEDIDO_STATUS_UPDATE,
          detalhes: JSON.stringify({
            pedido_id: pp.data.id,
            status_anterior: atual,
            status_novo: novo,
          }),
          ipOrigem: request.ip,
        })
      }

      return reply.status(200).send({
        ...serializePedido(updated as Record<string, unknown>),
        itens,
      })
    },
  )

  // ---------------------------------------------------------------------------
  // DELETE /pedidos/:id — exclusao fisica restrita (evita inconsistencia com pagamentos)
  // ---------------------------------------------------------------------------
  app.delete(
    '/pedidos/:id',
    {
      preHandler: [authenticate],
      attachValidation: true,
      schema: {
        tags: ['pedidos'],
        summary: 'Remover pedido (somente ADMIN)',
        description:
          'Exclui pedido e itens (CASCADE). Recomendado apenas para pedidos cancelados ou sem pagamento.',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: {
          204: { description: 'Pedido removido' },
          400: { description: 'Id invalido', ...errorResponseSchema },
          401: {
            description: 'Token invalido/ausente',
            ...errorResponseSchema,
          },
          403: { description: 'Sem permissao', ...errorResponseSchema },
          404: { description: 'Pedido nao encontrado', ...errorResponseSchema },
          409: { description: 'Nao pode excluir', ...errorResponseSchema },
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

      if (!isAdmin(request)) {
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

      const row = await db('pedidos').where({ id: parsed.data.id }).first()
      if (!row) {
        return reply.status(404).send({
          error: 'NAO_ENCONTRADO',
          message: 'Pedido nao encontrado.',
        })
      }

      const st = String((row as { status: string }).status)
      // Pedidos em andamento operacional nao devem ser apagados pelo painel (use cancelamento antes).
      if (st !== 'CANCELADO' && st !== 'AGUARDANDO_PAGAMENTO') {
        return reply.status(409).send({
          error: 'CONFLITO',
          message:
            'Somente pedidos cancelados ou aguardando pagamento podem ser excluidos.',
        })
      }

      // Se ja existe fluxo de pagamento registrado, exclusao do pedido quebraria integridade referencial/auditoria.
      const pag = await db('pagamentos')
        .where({ pedido_id: parsed.data.id })
        .first()
      if (pag) {
        return reply.status(409).send({
          error: 'CONFLITO',
          message:
            'Pedido possui registro de pagamento; nao pode ser excluido.',
        })
      }

      const unidadeId = String((row as { unidade_id: string }).unidade_id)
      const itensRows = await db('itens_pedido')
        .select('produto_id', 'quantidade')
        .where({ pedido_id: parsed.data.id })

      await db.transaction(async (trx) => {
        // Pedido ainda nao cancelado via PUT: estoque ainda esta baixado — devolve antes de apagar linhas (CASCADE nos itens).
        if (st === 'AGUARDANDO_PAGAMENTO') {
          await restaurarEstoque(
            trx,
            unidadeId,
            itensRows.map((r) => ({
              produto_id: String(r.produto_id),
              quantidade: Number(r.quantidade),
            })),
          )
        }
        await trx('pedidos').where({ id: parsed.data.id }).del()
      })

      const actorDel = getUsuarioIdFromRequest(request)
      if (actorDel) {
        await registrarLogAuditoria(request.log, {
          usuarioId: actorDel,
          acao: AcaoAuditoria.PEDIDO_DELETE,
          detalhes: JSON.stringify({
            pedido_id: parsed.data.id,
            status_anterior: st,
          }),
          ipOrigem: request.ip,
        })
      }

      return reply.status(204).send()
    },
  )
}
