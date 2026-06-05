import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('fidelidade', (table) => {
    table.uuid('id').primary()
    table.uuid('cliente_id').notNullable().unique()
    table.integer('saldo_pontos').notNullable().defaultTo(0)
    table.boolean('consentimento_explicitado').notNullable().defaultTo(false)
    table.timestamp('data_consentimento', { useTz: true })
    table.timestamp('ultima_atualizacao', { useTz: true }).defaultTo(knex.fn.now())

    table
      .foreign('cliente_id')
      .references('id')
      .inTable('usuarios')
      .onDelete('CASCADE')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('fidelidade')
}
