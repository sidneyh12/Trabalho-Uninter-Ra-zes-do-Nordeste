import knex from 'knex'
import type { Knex } from 'knex'

import { env } from './env/index.js'

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL not found in environment variables.')
}

export const config: Knex.Config = {
  client: env.DATABASE_CLIENT,
  connection:
    env.DATABASE_CLIENT === 'sqlite'
      ? {
          filename: env.DATABASE_URL,
        }
      : env.DATABASE_URL,
  useNullAsDefault: true,
  migrations: {
    extension: 'ts',
    directory: './db/migrations',
  },
  seeds: {
    extension: 'ts',
    directory: './db/seeds',
  },
}

export const db = knex(config)
