import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('logs_auditoria', (table) => {
    table.uuid('id').primary()
    table.uuid('usuario_id').notNullable()
    table.string('acao').notNullable()
    table.text('detalhes')
    table.string('ip_origem')
    table.timestamp('timestamp', { useTz: true }).defaultTo(knex.fn.now())

    table
      .foreign('usuario_id')
      .references('id')
      .inTable('usuarios')
      .onDelete('RESTRICT')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('logs_auditoria')
}
