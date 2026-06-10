# Raízes do Nordeste — API (backend)

API REST em **Node.js**, **Fastify**, **Knex** e **JWT**, desenvolvida no contexto do Projeto Multidisciplinar de Back-End da Uninter.

Este repositório está em **desenvolvimento incremental**: o schema completo do banco já existe nas migrations, mas as rotas implementadas até agora cobrem **autenticação**, **usuários**, **unidades**, **produtos** e **estoque**. Demais módulos (pedidos, campanhas, pagamentos etc.) estão previstos — veja `O-QUE-FALTA.md`.

**Todas as rotas REST ficam sob o prefixo `/v1`**, exceto a documentação Swagger em `/documentation`.

---

## Como executar localmente

Siga na ordem, na **raiz** do projeto:

| # | O que fazer | Comando / detalhe |
|---|-------------|-------------------|
| 1 | **Requisitos** | [Node.js](https://nodejs.org/) **24+** e **npm** |
| 2 | Instalar dependências | `npm install` |
| 3 | Variáveis de ambiente | Copie `.env.example` para `.env`<br>• PowerShell: `Copy-Item .env.example .env`<br>• Linux/macOS: `cp .env.example .env` |
| 4 | Criar tabelas | `npm run migrate` |
| 5 | Dados de demonstração | `npm run seed` |
| 6 | Subir a API | `npm run dev` |

**Conferência rápida:**

- Servidor: `http://localhost:3333` (ou a `PORT` do `.env`)
- Swagger: `http://localhost:3333/documentation`
- Login: `POST http://localhost:3333/v1/auth/login`

**Problemas comuns:** pasta `db` inexistente — crie ou ajuste `DATABASE_URL`; porta em uso — mude `PORT` no `.env`; erro de `JWT_SECRET` — confira se o `.env` está na raiz.

---

## Variáveis de ambiente

| Variável | Descrição |
|----------|-----------|
| `NODE_ENV` | `development`, `test` ou `production` |
| `DATABASE_CLIENT` | `sqlite` ou `pg` |
| `DATABASE_URL` | SQLite: caminho do arquivo (ex.: `./db/dev.db`). PostgreSQL: string de conexão |
| `JWT_SECRET` | Segredo do JWT (mínimo 8 caracteres) |
| `PORT` | Porta HTTP (padrão: `3333`) |

Em testes (`NODE_ENV=test`), o projeto carrega `.env.test` se existir (modelo em `.env.test.example`).

---

## Scripts

| Comando | Descrição |
|---------|-----------|
| `npm run dev` | Servidor com reload (`tsx watch`) |
| `npm run migrate` | Aplica migrations |
| `npm run seed` | Popula usuários demo e unidade |
| `npm run lint` | ESLint no código |
| `npm run build` | Build com tsup |
| `npm start` | Migrate + sobe build em produção |
| `npm test` | Vitest |
| `npm run knex -- <cmd>` | CLI Knex (rollback, etc.) |

### Banco de dados

```bash
npm run migrate
npm run seed

# Reverter última migration
npm run knex -- migrate:rollback
```

As migrations criam todas as tabelas do domínio (`usuarios`, `unidades`, `produtos`, `estoque`, `pedidos`, `pagamentos`, …). **Só parte delas tem rotas expostas nesta versão.**

---

## Usuários de demonstração (login)

Após `npm run seed`, use `POST /v1/auth/login` com JSON `email` + `senha`:

| Perfil | E-mail | Senha | Uso nesta versão |
|--------|--------|--------|------------------|
| **ADMIN** | `admin@raizes.com` | `Admin@123` | CRUD de usuários; escrita em unidades/produtos/estoque |
| **GERENTE** | `gerente@raizes.com` | `Gerente@123` | Escrita em unidades, produtos e estoque |
| **CLIENTE** | `cliente@raizes.com` | `Cliente@123` | Leitura de catálogo (unidades, produtos, estoque) |
| **COZINHA** | `cozinha@raizes.com` | `Cozinha@123` | Vinculado à Unidade Demo |
| **BALCAO** | `balcao@raizes.com` | `Balcao@123` | Vinculado à Unidade Demo |

A seed também cria a **Unidade Demo Nordeste** (`aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`).

> Senhas apenas para **desenvolvimento**.

---

## Documentação (Swagger)

Com a API rodando:

`http://localhost:<PORT>/documentation`

Lá estão os endpoints, schemas e o esquema **Bearer JWT** para testar rotas protegidas.

---

## Endpoints implementados

Prefixo: **`/v1`**

| Método | Caminho | Autenticação | Descrição |
|--------|---------|--------------|-----------|
| `POST` | `/v1/auth/login` | Não | Login; retorna `accessToken` (Bearer, 1h) |
| `GET` | `/v1/hello` | Sim (JWT) | Exemplo de rota protegida |
| `GET` | `/v1/usuarios` | Sim (**ADMIN**) | Lista usuários (`?page`, `?limit`) |
| `POST` | `/v1/usuarios` | Sim (**ADMIN**) | Cria usuário |
| `PUT` | `/v1/usuarios/:id` | Sim (**ADMIN**) | Atualização parcial |
| `DELETE` | `/v1/usuarios/:id` | Sim (**ADMIN**) | Remove usuário (**204**) |
| `GET` | `/v1/unidades` | Sim (qualquer perfil) | Lista unidades; filtro `?ativa=` |
| `GET` | `/v1/unidades/:id` | Sim (qualquer perfil) | Detalhe |
| `POST` | `/v1/unidades` | Sim (**ADMIN** ou **GERENTE**) | Cria unidade |
| `PUT` | `/v1/unidades/:id` | Sim (**ADMIN** ou **GERENTE**) | Atualiza |
| `DELETE` | `/v1/unidades/:id` | Sim (**ADMIN** ou **GERENTE**) | Remove (**409** se houver pedidos) |
| `GET` | `/v1/produtos` | Sim (qualquer perfil) | Lista produtos; filtro `?categoria=` |
| `GET` | `/v1/produtos/:id` | Sim (qualquer perfil) | Detalhe |
| `POST` | `/v1/produtos` | Sim (**ADMIN** ou **GERENTE**) | Cria produto |
| `PUT` | `/v1/produtos/:id` | Sim (**ADMIN** ou **GERENTE**) | Atualiza |
| `DELETE` | `/v1/produtos/:id` | Sim (**ADMIN** ou **GERENTE**) | Remove (**409** com vínculos) |
| `GET` | `/v1/estoque` | Sim (qualquer perfil) | Lista estoque; filtros `unidade_id`, `produto_id` |
| `GET` | `/v1/estoque/:id` | Sim (qualquer perfil) | Detalhe |
| `POST` | `/v1/estoque` | Sim (**ADMIN** ou **GERENTE**) | Cria linha de estoque |
| `PUT` | `/v1/estoque/:id` | Sim (**ADMIN** ou **GERENTE**) | Atualiza |
| `DELETE` | `/v1/estoque/:id` | Sim (**ADMIN** ou **GERENTE**) | Remove |

### Login

```json
POST /v1/auth/login
{
  "email": "admin@raizes.com",
  "senha": "Admin@123"
}
```

Resposta **200:** `accessToken`, `tokenType`, `expiresIn`, `user`.

### Rotas protegidas

```http
Authorization: Bearer <accessToken>
```

Erros padronizados: `{ "error": "...", "message": "..." }`.

### Usuários (somente ADMIN)

- **COZINHA** e **BALCAO** exigem `unidade_vinculada_id` no cadastro.
- Senha persistida com hash **scrypt** (`src/utils/password.ts`); nunca retorna na API.
- Mutações registram auditoria (`USUARIO_CREATE`, `USUARIO_UPDATE`, `USUARIO_DELETE`).

### Unidades

- Leitura: qualquer perfil autenticado.
- Escrita: **ADMIN** ou **GERENTE**.
- Campos: `nome`, `endereco`, `tipo_cozinha`, `ativa` (padrão `true`).

### Produtos

- Leitura: qualquer perfil autenticado.
- Escrita: **ADMIN** ou **GERENTE**.
- `preco_base` deve ser maior que zero.
- Exclusão bloqueada se houver itens de pedido ou movimentações vinculadas.

### Estoque

- Leitura: qualquer perfil autenticado.
- Escrita: **ADMIN** ou **GERENTE**.
- Par `unidade_id` + `produto_id` é único (**409** se duplicar).
- `quantidade_atual` e `ponto_reposicao` são inteiros `>= 0`.

---

## Estrutura do projeto

```
src/
  app.ts              # Fastify, JWT, Swagger, registro das rotas /v1
  server.ts           # Entrada HTTP
  database.ts         # Knex
  env/                # Variáveis validadas com Zod
  routes/             # auth, hello, users, unidades, produtos, estoque
  middlewares/        # authenticate (JWT)
  authz/              # Checagem de perfil (ADMIN, GERENTE)
  http/               # Erros padronizados
  services/           # Auditoria (gravação em logs_auditoria)
  utils/              # Hash de senha
db/
  migrations/         # Schema completo
  seeds/              # Usuários e unidade demo
test/                 # Testes (em evolução)
```

---

## Estado do desenvolvimento

**Pronto nesta versão:**

- Autenticação JWT + Swagger em `/documentation`
- CRUD de **usuários** (ADMIN)
- CRUD de **unidades**, **produtos** e **estoque** (leitura ampla; escrita ADMIN/GERENTE)
- Migrations, seed e registro de auditoria nas mutações
- Rotas versionadas em **`/v1`**

**Ainda não implementado** (schema já existe no banco):

- Movimentações de estoque, campanhas, pedidos, pagamentos, fidelidade
- Consulta de logs de auditoria (`GET /v1/logs-auditoria`)
- Rota raiz `GET /`

Detalhes no arquivo [`O-QUE-FALTA.md`](./O-QUE-FALTA.md).

---

## Licença

ISC (conforme `package.json`).
