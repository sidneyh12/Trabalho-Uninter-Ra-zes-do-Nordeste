import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('pagamentos', (table) => {
    table.uuid('id').primary()
    table.uuid('pedido_id').notNullable().unique()
    table.string('external_id')
    table.string('metodo_pagamento').notNullable()
    table.string('status_pagamento').notNullable()
    table.text('payload_retorno')

    table
      .foreign('pedido_id')
      .references('id')
      .inTable('pedidos')
      .onDelete('CASCADE')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('pagamentos')
}
