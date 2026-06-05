import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('campanhas', (table) => {
    table.uuid('id').primary()
    table.string('nome').notNullable()
    table.string('descricao')
    table.decimal('percentual_desconto', 5, 2).notNullable()
    table.timestamp('valido_de', { useTz: true }).notNullable()
    table.timestamp('valido_ate', { useTz: true }).notNullable()
    table.boolean('ativa').notNullable().defaultTo(true)
    table
      .uuid('unidade_id')
      .nullable()
      .references('id')
      .inTable('unidades')
      .onDelete('CASCADE')
    table.timestamp('criado_em', { useTz: true }).defaultTo(knex.fn.now())
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('campanhas')
}
