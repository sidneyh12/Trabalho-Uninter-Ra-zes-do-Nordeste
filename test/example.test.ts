import { expect, it, test, beforeAll, beforeEach, afterAll, describe } from 'vitest'
import { app } from '../src/app.js'
import request from 'supertest'

import { execSync } from 'node:child_process'



describe('Rotas para teste', () => {
    beforeAll(async () => {
        // execSync('npm run knex migrate:latest')
        await app.ready()
    })

    afterAll(async () => {
        await app.close()
    })

    beforeEach(() => {
        execSync('npm run knex migrate:rollback --all')
        execSync('npm run knex migrate:latest')
    })

    
})

