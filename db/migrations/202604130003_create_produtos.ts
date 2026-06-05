import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('produtos', (table) => {
    table.uuid('id').primary()
    table.string('nome').notNullable()
    table.text('descricao')
    table.decimal('preco_base', 10, 2).notNullable()
    table.string('categoria').notNullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('produtos')
}
