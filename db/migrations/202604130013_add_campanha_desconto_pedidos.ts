import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('pedidos', (table) => {
    table.decimal('valor_desconto', 10, 2).notNullable().defaultTo(0)
    table
      .uuid('campanha_id')
      .nullable()
      .references('id')
      .inTable('campanhas')
      .onDelete('SET NULL')
  })
}

export async function down(knex: Knex): Promise<void> {
  const client = String(knex.client.config.client)
  if (client === 'sqlite3' || client === 'sqlite') {
    await knex.schema.alterTable('pedidos', (table) => {
      table.dropColumn('campanha_id')
      table.dropColumn('valor_desconto')
    })
    return
  }
  await knex.schema.alterTable('pedidos', (table) => {
    table.dropForeign(['campanha_id'])
  })
  await knex.schema.alterTable('pedidos', (table) => {
    table.dropColumn('campanha_id')
    table.dropColumn('valor_desconto')
  })
}
