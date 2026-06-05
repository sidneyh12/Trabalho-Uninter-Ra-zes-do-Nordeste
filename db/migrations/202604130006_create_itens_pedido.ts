import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('itens_pedido', (table) => {
    table.uuid('id').primary()
    table.uuid('pedido_id').notNullable()
    table.uuid('produto_id').notNullable()
    table.integer('quantidade').notNullable()
    table.decimal('preco_unitario_no_momento', 10, 2).notNullable()

    table
      .foreign('pedido_id')
      .references('id')
      .inTable('pedidos')
      .onDelete('CASCADE')

    table
      .foreign('produto_id')
      .references('id')
      .inTable('produtos')
      .onDelete('RESTRICT')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('itens_pedido')
}
