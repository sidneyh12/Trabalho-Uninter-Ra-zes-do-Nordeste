import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('movimentacoes_estoque', (table) => {
    table.uuid('id').primary()
    table.uuid('unidade_id').notNullable()
    table.uuid('produto_id').notNullable()
    table
      .enu('tipo_movimentacao', ['ENTRADA', 'SAIDA'], {
        useNative: false,
        enumName: 'tipo_movimentacao_estoque'
      })
      .notNullable()
    table.integer('quantidade').notNullable()
    table.string('motivo')
    table.timestamp('criado_em', { useTz: true }).defaultTo(knex.fn.now())

    table
      .foreign('unidade_id')
      .references('id')
      .inTable('unidades')
      .onDelete('RESTRICT')

    table
      .foreign('produto_id')
      .references('id')
      .inTable('produtos')
      .onDelete('RESTRICT')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('movimentacoes_estoque')
}
