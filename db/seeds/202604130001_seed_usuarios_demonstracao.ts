import type { Knex } from 'knex'

import { hashPassword } from '../../src/utils/password.js'

/** Unidade fixa para perfis **COZINHA** e **BALCAO** (requisito da API para esses perfis). */
const UNIDADE_DEMO_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

/**
 * Usuários de demonstração — um registro por perfil aceito na API (`ADMIN`, `GERENTE`, `CLIENTE`, `COZINHA`, `BALCAO`).
 * Senhas previsíveis só para desenvolvimento / testes manuais.
 *
 * Idempotente: se o email já existir, atualiza nome, senha, perfil e `unidade_vinculada_id` quando aplicável.
 */
const USUARIOS = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    nome: 'Administrador Demo',
    email: 'admin@raizes.com',
    perfil: 'ADMIN',
    senhaPlano: 'Admin@123',
    data_nascimento: '1990-01-01'
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    nome: 'Gerente Demo',
    email: 'gerente@raizes.com',
    perfil: 'GERENTE',
    senhaPlano: 'Gerente@123',
    data_nascimento: '1988-05-15'
  },
  {
    id: '33333333-3333-3333-3333-333333333333',
    nome: 'Cliente Demo',
    email: 'cliente@raizes.com',
    perfil: 'CLIENTE',
    senhaPlano: 'Cliente@123',
    data_nascimento: '2001-03-20'
  },
  {
    id: '44444444-4444-4444-4444-444444444444',
    nome: 'Cozinha Demo',
    email: 'cozinha@raizes.com',
    perfil: 'COZINHA',
    senhaPlano: 'Cozinha@123',
    data_nascimento: '1992-07-08'
  },
  {
    id: '55555555-5555-5555-5555-555555555555',
    nome: 'Balcão Demo',
    email: 'balcao@raizes.com',
    perfil: 'BALCAO',
    senhaPlano: 'Balcao@123',
    data_nascimento: '1995-11-30'
  }
] as const

function unidadeParaPerfil(perfil: string): string | null {
  return perfil === 'COZINHA' || perfil === 'BALCAO' ? UNIDADE_DEMO_ID : null
}

async function ensureUnidadeDemo(knex: Knex): Promise<void> {
  const existing = await knex('unidades').where({ id: UNIDADE_DEMO_ID }).first()
  const row = {
    nome: 'Unidade Demo Nordeste',
    endereco: 'Rua Demo, 100 — Centro',
    tipo_cozinha: 'Nordestina',
    ativa: true
  }
  if (existing) {
    await knex('unidades').where({ id: UNIDADE_DEMO_ID }).update(row)
  } else {
    await knex('unidades').insert({ id: UNIDADE_DEMO_ID, ...row })
  }
}

export async function seed(knex: Knex): Promise<void> {
  await ensureUnidadeDemo(knex)

  for (const u of USUARIOS) {
    const senha_hash = hashPassword(u.senhaPlano)
    const unidade_vinculada_id = unidadeParaPerfil(u.perfil)
    const existing = await knex('usuarios').where({ email: u.email }).first()

    if (existing) {
      await knex('usuarios')
        .where({ email: u.email })
        .update({
          nome: u.nome,
          senha_hash,
          perfil: u.perfil,
          data_nascimento: u.data_nascimento,
          unidade_vinculada_id
        })
    } else {
      await knex('usuarios').insert({
        id: u.id,
        nome: u.nome,
        email: u.email,
        senha_hash,
        perfil: u.perfil,
        data_nascimento: u.data_nascimento,
        criado_em: knex.fn.now(),
        unidade_vinculada_id
      })
    }
  }
}
