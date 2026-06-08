import { randomUUID } from 'node:crypto'
import type { FastifyBaseLogger } from 'fastify'

import { db } from '../database.js'

export const AcaoAuditoria = {
  AUTH_LOGIN: 'AUTH_LOGIN',
} as const

type RegistrarParams = {
  usuarioId: string
  acao: string
  detalhes?: string | null
  ipOrigem?: string | null
}

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
