import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('pedidos', (table) => {
    table.uuid('id').primary()
    table.uuid('cliente_id').notNullable()
    table.uuid('unidade_id').notNullable()
    table
      .enu('canalPedido', ['APP', 'TOTEM', 'BALCAO', 'PICKUP', 'WEB'], {
        useNative: false,
        enumName: 'canal_pedido'
      })
      .notNullable()
    table.string('status').notNullable()
    table.decimal('valor_total', 10, 2).notNullable()
    table.timestamp('criado_em', { useTz: true }).defaultTo(knex.fn.now())

    table
      .foreign('cliente_id')
      .references('id')
      .inTable('usuarios')
      .onDelete('RESTRICT')

    table
      .foreign('unidade_id')
      .references('id')
      .inTable('unidades')
      .onDelete('RESTRICT')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('pedidos')
}
