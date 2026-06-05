import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('usuarios', (table) => {
    table
      .uuid('unidade_vinculada_id')
      .nullable()
      .references('id')
      .inTable('unidades')
      .onDelete('SET NULL')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('usuarios', (table) => {
    table.dropColumn('unidade_vinculada_id')
  })
}
