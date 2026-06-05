import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('usuarios', (table) => {
    table.uuid('id').primary()
    table.string('nome').notNullable()
    table.string('email').notNullable().unique()
    table.string('senha_hash').notNullable()
    table.string('perfil').notNullable()
    table.date('data_nascimento')
    table.timestamp('criado_em', { useTz: true }).defaultTo(knex.fn.now())
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('usuarios')
}
