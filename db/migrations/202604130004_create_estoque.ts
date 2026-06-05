import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('estoque', (table) => {
    table.uuid('id').primary()
    table.uuid('unidade_id').notNullable()
    table.uuid('produto_id').notNullable()
    table.integer('quantidade_atual').notNullable().defaultTo(0)
    table.integer('ponto_reposicao').notNullable().defaultTo(0)

    table
      .foreign('unidade_id')
      .references('id')
      .inTable('unidades')
      .onDelete('CASCADE')

    table
      .foreign('produto_id')
      .references('id')
      .inTable('produtos')
      .onDelete('CASCADE')

    table.unique(['unidade_id', 'produto_id'])
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('estoque')
}
