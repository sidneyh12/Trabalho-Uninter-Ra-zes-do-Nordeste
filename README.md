# Raízes do Nordeste — API (backend)

Trabalho do **Projeto Multidisciplinar de Back-End (Uninter)**. API REST com **Node.js**, **Fastify**, **Knex** e **JWT** para a rede fictícia Raízes do Nordeste (pedidos multicanal, estoque por unidade, campanhas, pagamento simulado e programa de fidelidade).

As rotas “de verdade” ficam em **`/v1`**. Fora disso: **`GET /`** (texto `Hello World`) e o Swagger em **`/documentation`**.

---

## Como rodar na sua máquina

Fiz na ordem abaixo e funcionou com SQLite. Tudo na **raiz** do projeto (onde está o `package.json`).

| # | Passo | O que rodar |
|---|--------|-------------|
| 1 | Ter Node e npm | [Node.js](https://nodejs.org/) **24+** (é o que está no `package.json`) |
| 2 | Instalar pacotes | `npm install` |
| 3 | Criar o `.env` | Copie `.env.example` → `.env`<br>PowerShell: `Copy-Item .env.example .env` |
| 4 | Criar tabelas | `npm run migrate` |
| 5 | Usuários de teste | `npm run seed` |
| 6 | Subir a API | `npm run dev` |

**Conferir se deu certo:**

- `http://localhost:3333/` → deve aparecer `Hello World`
- `http://localhost:3333/documentation` → Swagger
- Login: `POST http://localhost:3333/v1/auth/login`

**Se der erro:** confira se o `.env` está na raiz; se a pasta `db` existe (o SQLite grava em `./db/dev.db`); se a porta 3333 não está ocupada (mude `PORT` no `.env`).

---

## Variáveis de ambiente

| Variável | Para que serve |
|----------|----------------|
| `NODE_ENV` | `development`, `test` ou `production` |
| `DATABASE_CLIENT` | `sqlite` ou `pg` |
| `DATABASE_URL` | SQLite: `./db/dev.db`. Postgres: string de conexão |
| `JWT_SECRET` | Segredo do token (mínimo 8 caracteres) |
| `PORT` | Porta do servidor (padrão `3333`) |

Para testes existe `.env.test.example` — útil se for configurar Vitest depois.

---

## Scripts que usei no dia a dia

| Comando | O que faz |
|---------|-----------|
| `npm run dev` | API com reload automático |
| `npm run migrate` | Aplica migrations |
| `npm run seed` | Cria usuários demo + unidade |
| `npm run lint` | ESLint no `src/` |
| `npm run build` | Gera pasta `build/` |
| `npm test` | Vitest (ainda quase sem casos — ver abaixo) |
| `npm run knex -- <cmd>` | Knex direto (rollback, etc.) |

---

## Login de demonstração

Depois do `npm run seed`, use `POST /v1/auth/login` com JSON:

| Perfil | E-mail | Senha | Uso no trabalho |
|--------|--------|--------|-----------------|
| **ADMIN** | `admin@raizes.com` | `Admin@123` | Usuários e quase tudo |
| **GERENTE** | `gerente@raizes.com` | `Gerente@123` | Catálogo, estoque, campanhas, auditoria |
| **CLIENTE** | `cliente@raizes.com` | `Cliente@123` | Pedidos e pagamentos próprios |
| **COZINHA** | `cozinha@raizes.com` | `Cozinha@123` | Fila da unidade vinculada |
| **BALCAO** | `balcao@raizes.com` | `Balcao@123` | Balcão + pagamentos da loja |

> Senhas só para **estudo/local**. Não usar em produção.

A seed também cria a **Unidade Demo** (`aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`) e liga COZINHA/BALCAO nela.

---

## Documentação da API (Swagger)

Com `npm run dev` rodando, abra:

`http://localhost:3333/documentation`

Lá dá para ver os endpoints, schemas e testar com Bearer token depois do login.

Tem também uma coleção Postman em `docs/colecao_postman.json` e diagramas do trabalho (`docs/*.png`).

---

## Endpoints (resumo)

Prefixo: **`/v1`**. Quase tudo exige header `Authorization: Bearer <token>` (exceto login e `GET /`).

| Método | Caminho | Quem / obs |
|--------|---------|------------|
| `GET` | `/` | Público — `Hello World` |
| `POST` | `/v1/auth/login` | Público — retorna JWT |
| `GET` | `/v1/hello` | Qualquer logado (exemplo) |

### Usuários — `/v1/usuarios` (**ADMIN**)

`GET` (lista), `POST`, `PUT /:id`, `DELETE /:id`

### Unidades, produtos, estoque

| Recurso | Caminho |
|---------|---------|
| Unidades | `/v1/unidades` |
| Produtos | `/v1/produtos` |
| Estoque | `/v1/estoque` |

Leitura: qualquer autenticado. Escrita: **ADMIN** ou **GERENTE**. CRUD completo em cada um.

### Movimentações — `/v1/movimentacoes-estoque`

`ENTRADA` / `SAIDA` atualizando saldo. Escrita: **ADMIN** ou **GERENTE**.

### Campanhas — `/v1/campanhas`

Desconto percentual; filtros `?ativas`, `?unidade_id`. Escrita: **ADMIN** ou **GERENTE**.

### Pedidos — `/v1/pedidos`

Multicanal (`APP`, `TOTEM`, `BALCAO`, `PICKUP`, `WEB`). Status:  
`AGUARDANDO_PAGAMENTO` → `EM_PREPARO` → `PRONTO` → `ENTREGUE` / `CANCELADO`

- **CLIENTE**: só os seus
- **COZINHA/BALCAO**: da unidade vinculada
- **ADMIN/GERENTE**: visão ampla

### Pagamentos (mock) — `/v1/pagamentos`

- `POST` com `resultado_mock`: `APROVADO` ou `NEGADO`
- Pedido precisa estar em `AGUARDANDO_PAGAMENTO`
- **APROVADO** → `EM_PREPARO` + pontos de fidelidade (se tiver consentimento)
- **NEGADO** → cancela e devolve estoque

### Fidelidade — `/v1/fidelidade`

Pontos + `consentimento_explicitado` (LGPD). CRUD de escrita: **ADMIN/GERENTE**; **CLIENTE** só vê o dele.

### Auditoria (só leitura) — `/v1/logs-auditoria`

**ADMIN** ou **GERENTE**. Lista e detalhe; os logs são gravados sozinhos nas mutações (POST/PUT/DELETE).

---

## Exemplos que testei no Insomnia/Swagger

**Login**

```json
POST /v1/auth/login
{ "email": "admin@raizes.com", "senha": "Admin@123" }
```

**Pedido**

```http
Authorization: Bearer <accessToken>
```

```json
POST /v1/pedidos
{
  "unidade_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  "canalPedido": "APP",
  "itens": [{ "produto_id": "<uuid-do-produto>", "quantidade": 1 }]
}
```

**Pagamento aprovado**

```json
POST /v1/pagamentos
{
  "pedido_id": "<uuid-do-pedido>",
  "metodo_pagamento": "PIX",
  "resultado_mock": "APROVADO"
}
```

**Fidelidade do cliente demo**

```json
POST /v1/fidelidade
{
  "cliente_id": "33333333-3333-3333-3333-333333333333",
  "consentimento_explicitado": true
}
```

---

## Como o código está organizado

```
src/
  app.ts              # Fastify, JWT, Swagger, registra /v1
  server.ts           # Sobe o HTTP
  database.ts         # Knex
  routes/             # Uma pasta por módulo (auth, pedidos, etc.)
  middlewares/        # authenticate.ts (JWT)
  authz/              # Checagem de perfil
  http/errors.ts      # Erros padronizados { error, message }
  services/           # audit-log.ts
  utils/              # hash de senha (scrypt)
db/
  migrations/         # Todas as tabelas do enunciado
  seeds/              # Usuários + unidade demo
docs/                 # Diagramas + Postman
test/                 # Vitest (estrutura pronta, poucos testes ainda)
```

---

## Material que consultei (organização da API)

Montei as rotas pensando no que vi na **Rocketseat** (curso de Node), principalmente a parte de **HTTP e rotas**: separar arquivos por recurso, responder com status certo e manter JSON previsível (`error` + `message` quando dá ruim).

- Site: [rocketseat.com.br](https://www.rocketseat.com.br/)

Não é cópia linha a linha — adaptei pro enunciado da faculdade (perfis, pedidos, estoque, LGPD na fidelidade, etc.).

---

## O que já está pronto e o que ainda dá pra melhorar

**Já implementei (escopo da API):**

- Login JWT + Swagger
- CRUDs: usuários, unidades, produtos, estoque, movimentações, campanhas, pedidos, pagamentos, fidelidade
- Consulta de logs de auditoria
- Auditoria gravando nas alterações importantes
- Migrations + seed para testar sem cadastrar tudo na mão

**Ainda não fiz / ficou fraco (honestidade de projeto de faculdade):**

- **Testes automatizados** — a pasta `test/` existe e o `npm test` roda, mas quase não tem caso de teste escrito ainda; hoje valido mais no Swagger e no Postman
- **Seed de fidelidade** — dá pra criar via API; não coloquei na seed inicial
- **Coleção Postman** — está em `docs/`, mas pode precisar de ajuste fino de UUIDs depois do seed

Se no futuro sobrar tempo, o próximo passo natural seria escrever uns testes de login + criar pedido + pagamento mock.

---

## Licença

ISC (ver `package.json`).
