import { randomUUID } from 'node:crypto'
import type { FastifyBaseLogger, FastifyRequest } from 'fastify'

import { db } from '../database.js'

// Nomes fixos das ações que salvamos na tabela logs_auditoria.
// Assim fica fácil filtrar depois quem criou/alterou o quê.
export const AcaoAuditoria = {
  AUTH_LOGIN: 'AUTH_LOGIN',
  USUARIO_CREATE: 'USUARIO_CREATE',
  USUARIO_UPDATE: 'USUARIO_UPDATE',
  USUARIO_DELETE: 'USUARIO_DELETE',
  UNIDADE_CREATE: 'UNIDADE_CREATE',
  UNIDADE_UPDATE: 'UNIDADE_UPDATE',
  UNIDADE_DELETE: 'UNIDADE_DELETE',
  PRODUTO_CREATE: 'PRODUTO_CREATE',
  PRODUTO_UPDATE: 'PRODUTO_UPDATE',
  PRODUTO_DELETE: 'PRODUTO_DELETE',
  ESTOQUE_CREATE: 'ESTOQUE_CREATE',
  ESTOQUE_UPDATE: 'ESTOQUE_UPDATE',
  ESTOQUE_DELETE: 'ESTOQUE_DELETE',
  MOVIMENTACAO_ESTOQUE_CREATE: 'MOVIMENTACAO_ESTOQUE_CREATE',
  MOVIMENTACAO_ESTOQUE_UPDATE: 'MOVIMENTACAO_ESTOQUE_UPDATE',
  MOVIMENTACAO_ESTOQUE_DELETE: 'MOVIMENTACAO_ESTOQUE_DELETE',
} as const

// Pega o id do usuário que está logado (campo "sub" dentro do JWT).
export function getUsuarioIdFromRequest(
  request: FastifyRequest,
): string | undefined {
  const sub = (request.user as { sub?: string } | undefined)?.sub
  return typeof sub === 'string' && sub.length > 0 ? sub : undefined
}

type RegistrarParams = {
  usuarioId: string
  acao: string
  detalhes?: string | null
  ipOrigem?: string | null
}

// Grava um registro na tabela de auditoria.
// Se der erro no banco, só loga no console — a rota principal não quebra.
export async function registrarLogAuditoria(
  logger: FastifyBaseLogger | undefined,
  input: RegistrarParams,
): Promise<void> {
  try {
    await db('logs_auditoria').insert({
      id: randomUUID(),
      usuario_id: input.usuarioId,
      acao: input.acao,
      detalhes: input.detalhes ?? null,
      ip_origem: input.ipOrigem ?? null,
    })
  } catch (err) {
    logger?.error({ err }, 'Falha ao registrar log de auditoria')
  }
}
