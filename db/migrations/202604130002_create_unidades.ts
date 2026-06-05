import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('unidades', (table) => {
    table.uuid('id').primary()
    table.string('nome').notNullable()
    table.string('endereco').notNullable()
    table.string('tipo_cozinha').notNullable()
    table.boolean('ativa').notNullable().defaultTo(true)
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('unidades')
}
