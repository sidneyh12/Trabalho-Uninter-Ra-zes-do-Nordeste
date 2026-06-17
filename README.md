# Raízes do Nordeste — API (backend)

API REST em **Node.js**, **Fastify**, **Knex** e **JWT**, desenvolvida no contexto do Projeto Multidisciplinar de Back-End da Uninter.

O schema completo do banco já existe nas migrations; as rotas implementadas cobrem **autenticação**, **usuários**, **unidades**, **produtos**, **estoque**, **movimentações de estoque**, **campanhas**, **pedidos**, **pagamentos** e **fidelidade**.

**Todas as rotas REST ficam sob o prefixo `/v1`**, exceto a documentação Swagger em `/documentation`.

---

## Como executar localmente

| # | O que fazer | Comando / detalhe |
|---|-------------|-------------------|
| 1 | **Requisitos** | [Node.js](https://nodejs.org/) **24+** e **npm** |
| 2 | Instalar dependências | `npm install` |
| 3 | Variáveis de ambiente | Copie `.env.example` para `.env` |
| 4 | Criar tabelas | `npm run migrate` |
| 5 | Dados de demonstração | `npm run seed` |
| 6 | Subir a API | `npm run dev` |

**Conferência rápida:**

- Servidor: `http://localhost:3333` (ou a `PORT` do `.env`)
- Swagger: `http://localhost:3333/documentation`
- Login: `POST http://localhost:3333/v1/auth/login`

---

## Variáveis de ambiente

| Variável | Descrição |
|----------|-----------|
| `NODE_ENV` | `development`, `test` ou `production` |
| `DATABASE_CLIENT` | `sqlite` ou `pg` |
| `DATABASE_URL` | SQLite: `./db/dev.db`. PostgreSQL: string de conexão |
| `JWT_SECRET` | Segredo do JWT (mínimo 8 caracteres) |
| `PORT` | Porta HTTP (padrão: `3333`) |

---

## Scripts

| Comando | Descrição |
|---------|-----------|
| `npm run dev` | Servidor com reload |
| `npm run migrate` | Aplica migrations |
| `npm run seed` | Popula usuários demo e unidade |
| `npm run lint` | ESLint |
| `npm run build` | Build com tsup |
| `npm test` | Vitest |

---

## Usuários de demonstração (login)

Após `npm run seed`, use `POST /v1/auth/login`:

| Perfil | E-mail | Senha | Uso principal |
|--------|--------|--------|---------------|
| **ADMIN** | `admin@raizes.com` | `Admin@123` | CRUD usuários; gestão ampla |
| **GERENTE** | `gerente@raizes.com` | `Gerente@123` | Escrita em catálogo, estoque, campanhas |
| **CLIENTE** | `cliente@raizes.com` | `Cliente@123` | Pedidos próprios; leitura de catálogo |
| **COZINHA** | `cozinha@raizes.com` | `Cozinha@123` | Fila de pedidos da unidade vinculada |
| **BALCAO** | `balcao@raizes.com` | `Balcao@123` | Fila de pedidos da unidade vinculada |

> Senhas apenas para **desenvolvimento**.

---

## Endpoints implementados

Prefixo: **`/v1`**

### Autenticação e exemplo

| Método | Caminho | Autenticação | Descrição |
|--------|---------|--------------|-----------|
| `POST` | `/v1/auth/login` | Não | Login JWT (1h) |
| `GET` | `/v1/hello` | Sim (JWT) | Rota protegida de exemplo |

### Usuários (`/v1/usuarios`) — somente **ADMIN**

| Método | Descrição |
|--------|-----------|
| `GET` | Lista paginada |
| `POST` | Cria usuário |
| `PUT /:id` | Atualização parcial |
| `DELETE /:id` | Remove (**204**) |

### Unidades, produtos, estoque — leitura: qualquer autenticado; escrita: **ADMIN** ou **GERENTE**

| Recurso | Caminho base |
|---------|--------------|
| Unidades | `/v1/unidades` |
| Produtos | `/v1/produtos` |
| Estoque | `/v1/estoque` |

Cada um com `GET`, `GET /:id`, `POST`, `PUT /:id`, `DELETE /:id`.

### Movimentações de estoque (`/v1/movimentacoes-estoque`)

| Método | Quem pode | Descrição |
|--------|-----------|-----------|
| `GET` | Qualquer autenticado | Lista com filtros |
| `GET /:id` | Qualquer autenticado | Detalhe |
| `POST` | **ADMIN** ou **GERENTE** | ENTRADA/SAIDA — atualiza estoque |
| `PUT /:id` | **ADMIN** ou **GERENTE** | Atualiza (reverte e reaplica) |
| `DELETE /:id` | **ADMIN** ou **GERENTE** | Remove e reverte saldo |

### Campanhas (`/v1/campanhas`)

| Método | Quem pode | Descrição |
|--------|-----------|-----------|
| `GET` | Qualquer autenticado | Lista; filtros `?ativas`, `?unidade_id` |
| `GET /:id` | Qualquer autenticado | Detalhe |
| `POST` | **ADMIN** ou **GERENTE** | Cria campanha promocional |
| `PUT /:id` | **ADMIN** ou **GERENTE** | Atualiza |
| `DELETE /:id` | **ADMIN** ou **GERENTE** | Remove |

### Pedidos (`/v1/pedidos`)

| Método | Quem pode | Descrição |
|--------|-----------|-----------|
| `GET` | Por perfil | CLIENTE: só os seus; ADMIN/GERENTE: todos; COZINHA/BALCAO: da unidade |
| `GET /:id` | Por perfil | Detalhe com itens |
| `POST` | Qualquer autenticado | Cria pedido, baixa estoque; opcional `campanha_id` |
| `PUT /:id` | Regras de status | Atualiza status (máquina de estados) |
| `DELETE /:id` | **ADMIN** | Remove com restrições |

**Canais:** `APP`, `TOTEM`, `BALCAO`, `PICKUP`, `WEB`

**Status:** `AGUARDANDO_PAGAMENTO` → `EM_PREPARO` → `PRONTO` → `ENTREGUE` / `CANCELADO`

### Pagamentos (`/v1/pagamentos`) — mock de gateway

| Método | Quem pode | Descrição |
|--------|-----------|-----------|
| `GET` | Por perfil | ADMIN/GERENTE: todos; demais: só dos próprios pedidos |
| `GET /:id` | Por perfil | Detalhe por UUID |
| `POST` | Dono do pedido ou **ADMIN**/**GERENTE**/**BALCAO** | Mock `resultado_mock`: `APROVADO` ou `NEGADO` |
| `PUT /:id` | **ADMIN**, **GERENTE** ou **BALCAO** | Atualiza metadados (`metodo_pagamento`, `external_id`, `payload_retorno`) |
| `DELETE /:id` | **ADMIN** | Remove apenas pagamento **NEGADO** |

**Regras do POST:**

- Pedido deve estar em `AGUARDANDO_PAGAMENTO`; um pagamento por pedido
- **APROVADO** → pedido `EM_PREPARO`; credita fidelidade se houver consentimento
- **NEGADO** → pedido `CANCELADO` e restaura estoque
- Resposta `201`: `{ pagamento, pedido }`

### Fidelidade (`/v1/fidelidade`)

| Método | Quem pode | Descrição |
|--------|-----------|-----------|
| `GET` | Por perfil | ADMIN/GERENTE: todos; CLIENTE: só o próprio |
| `GET /:id` | Por perfil | Detalhe por UUID |
| `POST` | **ADMIN** ou **GERENTE** | Cria registro (um por cliente) |
| `PUT /:id` | **ADMIN** ou **GERENTE** | Saldo, consentimento LGPD, `ajuste_pontos_delta` |
| `DELETE /:id` | **ADMIN** | Remove registro |

**Consentimento:** com `consentimento_explicitado: true`, pagamentos aprovados creditam pontos (`floor(valor_total)`).

---

## Exemplos rápidos

### Login

```json
POST /v1/auth/login
{ "email": "admin@raizes.com", "senha": "Admin@123" }
```

### Pedido com campanha

```http
Authorization: Bearer <accessToken>
```

```json
POST /v1/pedidos
{
  "unidade_id": "<uuid>",
  "canalPedido": "APP",
  "campanha_id": "<uuid-opcional>",
  "itens": [{ "produto_id": "<uuid>", "quantidade": 2 }]
}
```

### Pagamento mock

```json
POST /v1/pagamentos
{
  "pedido_id": "<uuid-do-pedido>",
  "metodo_pagamento": "PIX",
  "resultado_mock": "APROVADO"
}
```

### Cadastro de fidelidade

```json
POST /v1/fidelidade
{
  "cliente_id": "33333333-3333-3333-3333-333333333333",
  "consentimento_explicitado": true
}
```

---

## Estrutura do projeto

```
src/
  app.ts              # Fastify, JWT, Swagger, rotas /v1
  routes/             # auth, hello, users, unidades, produtos,
                        # estoque, movimentacoes-estoque, campanhas,
                        # pedidos, pagamentos, fidelidade
  middlewares/        # authenticate (JWT)
  authz/              # perfis (ADMIN, GERENTE)
  http/               # erros padronizados
  services/           # auditoria
  utils/              # hash de senha
db/
  migrations/         # schema completo
  seeds/              # usuários e unidade demo
```

---

## Estado do desenvolvimento

**Implementado:**

- Autenticação JWT + Swagger (`/documentation`)
- CRUD: usuários, unidades, produtos, estoque, movimentações, campanhas, pedidos, pagamentos, fidelidade
- Pedidos com itens, desconto de campanha, baixa/devolução de estoque
- Pagamentos mock com transição de status do pedido e crédito de fidelidade
- Programa de fidelidade com consentimento LGPD e ajuste de pontos
- Auditoria nas mutações; rotas em **`/v1`**

**Ainda falta** (migrations já existem):

- **Logs de auditoria** — leitura (`GET /v1/logs-auditoria`)
- Rota raiz `GET /`

---

## Licença

ISC (conforme `package.json`).
