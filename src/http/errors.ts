import { z } from 'zod'

export const errorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
})

export type ErrorResponse = z.infer<typeof errorResponseSchema>

export function unauthorizedError(
  message = 'Token ausente, invalido ou expirado.',
): ErrorResponse {
  return {
    error: 'NAO_AUTORIZADO',
    message,
  }
}

export function invalidCredentialsError(): ErrorResponse {
  return {
    error: 'CREDENCIAIS_INVALIDAS',
    message: 'Email ou senha invalidos.',
  }
}

export function invalidPayloadError(): ErrorResponse {
  return {
    error: 'DADOS_INVALIDOS',
    message: 'Email e senha devem ser enviados no formato correto.',
  }
}

// 403 — usuário logado mas sem permissão (ex.: GERENTE tentando criar usuário).
export function forbiddenError(
  message = 'Perfil sem permissao para executar esta acao.',
): ErrorResponse {
  return {
    error: 'ACESSO_NEGADO',
    message,
  }
}

// Erros de validação dos CRUDs — cada um com mensagem que faz sentido pro front.

export function invalidUserCreationPayloadError(): ErrorResponse {
  return {
    error: 'DADOS_INVALIDOS',
    message:
      'Dados de cadastro invalidos. Verifique nome, email, senha, perfil e data_nascimento.',
  }
}

export function invalidUserUpdatePayloadError(): ErrorResponse {
  return {
    error: 'DADOS_INVALIDOS',
    message:
      'Dados de atualizacao invalidos. Envie ao menos um campo valido (nome, email, senha, perfil, data_nascimento).',
  }
}

// --- Unidades ---

export function invalidUnidadeCreationPayloadError(): ErrorResponse {
  return {
    error: 'DADOS_INVALIDOS',
    message:
      'Dados invalidos. Informe nome, endereco e tipo_cozinha; opcionalmente ativa (boolean).',
  }
}

export function invalidUnidadeUpdatePayloadError(): ErrorResponse {
  return {
    error: 'DADOS_INVALIDOS',
    message:
      'Dados de atualizacao invalidos. Envie ao menos um campo valido (nome, endereco, tipo_cozinha, ativa).',
  }
}

// --- Produtos ---

export function invalidProdutoCreationPayloadError(): ErrorResponse {
  return {
    error: 'DADOS_INVALIDOS',
    message:
      'Dados invalidos. Informe nome, preco_base (maior que zero) e categoria; descricao e opcional.',
  }
}

export function invalidProdutoUpdatePayloadError(): ErrorResponse {
  return {
    error: 'DADOS_INVALIDOS',
    message:
      'Dados de atualizacao invalidos. Envie ao menos um campo valido (nome, descricao, preco_base, categoria).',
  }
}

// --- Estoque ---

export function invalidEstoqueCreationPayloadError(): ErrorResponse {
  return {
    error: 'DADOS_INVALIDOS',
    message:
      'Dados invalidos. Informe unidade_id e produto_id (UUID); quantidade_atual e ponto_reposicao devem ser inteiros >= 0.',
  }
}

export function invalidEstoqueUpdatePayloadError(): ErrorResponse {
  return {
    error: 'DADOS_INVALIDOS',
    message:
      'Dados de atualizacao invalidos. Envie ao menos um campo valido (unidade_id, produto_id, quantidade_atual, ponto_reposicao).',
  }
}

// --- Movimentações de estoque ---

export function invalidMovimentacaoEstoqueCreationPayloadError(): ErrorResponse {
  return {
    error: 'DADOS_INVALIDOS',
    message:
      'Dados invalidos. Informe unidade_id, produto_id, tipo_movimentacao (ENTRADA|SAIDA) e quantidade inteira >= 1; motivo e opcional.',
  }
}

export function invalidMovimentacaoEstoqueUpdatePayloadError(): ErrorResponse {
  return {
    error: 'DADOS_INVALIDOS',
    message:
      'Dados de atualizacao invalidos. Envie ao menos um campo valido (unidade_id, produto_id, tipo_movimentacao, quantidade, motivo).',
  }
}

// --- Pedidos ---

export function invalidPedidoCreationPayloadError(): ErrorResponse {
  return {
    error: 'DADOS_INVALIDOS',
    message:
      'Dados invalidos. Informe unidade_id, canalPedido (APP|TOTEM|BALCAO|PICKUP|WEB) e itens com produto_id e quantidade >= 1.',
  }
}

export function invalidPedidoUpdatePayloadError(): ErrorResponse {
  return {
    error: 'DADOS_INVALIDOS',
    message:
      'Informe status valido (AGUARDANDO_PAGAMENTO|EM_PREPARO|PRONTO|ENTREGUE|CANCELADO).',
  }
}

// --- Pagamentos ---

export function invalidPagamentoCreationPayloadError(): ErrorResponse {
  return {
    error: 'DADOS_INVALIDOS',
    message:
      'Dados invalidos. Informe pedido_id, metodo_pagamento e resultado_mock (APROVADO|NEGADO); external_id e payload_retorno sao opcionais.',
  }
}

export function pagamentoPedidoStatusInvalidoError(
  statusAtual: string,
): ErrorResponse {
  return {
    error: 'PEDIDO_STATUS_INVALIDO',
    message: `Pagamento so pode ser registrado para pedido em AGUARDANDO_PAGAMENTO. Status atual: ${statusAtual}.`,
  }
}

export function pagamentoJaRegistradoError(): ErrorResponse {
  return {
    error: 'PAGAMENTO_JA_REGISTRADO',
    message: 'Este pedido ja possui pagamento registrado.',
  }
}

export function invalidPagamentoUpdatePayloadError(): ErrorResponse {
  return {
    error: 'DADOS_INVALIDOS',
    message:
      'Dados de atualizacao invalidos. Envie ao menos um campo valido (metodo_pagamento, external_id, payload_retorno).',
  }
}

// --- Fidelidade ---

export function invalidFidelidadeCreationPayloadError(): ErrorResponse {
  return {
    error: 'DADOS_INVALIDOS',
    message:
      'Dados invalidos. Informe cliente_id (UUID); saldo_pontos >= 0 e campos de consentimento opcionais.',
  }
}

export function invalidFidelidadeUpdatePayloadError(): ErrorResponse {
  return {
    error: 'DADOS_INVALIDOS',
    message:
      'Dados de atualizacao invalidos. Envie ao menos um campo valido (saldo_pontos, ajuste_pontos_delta, consentimento_explicitado, data_consentimento).',
  }
}
