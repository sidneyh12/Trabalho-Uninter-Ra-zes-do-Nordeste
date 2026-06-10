// Funções auxiliares pra checar o perfil do usuário logado.
// O JWT guarda o perfil dentro de request.user (vem do token no login).

// Só ADMIN pode gerenciar usuários da rede.
export function isPerfilAdmin(request: { user?: unknown }): boolean {
  return (request.user as { perfil?: string } | undefined)?.perfil === 'ADMIN'
}

// ADMIN e GERENTE podem cadastrar unidade, produto, estoque etc.
export function isAdminOuGerente(request: { user?: unknown }): boolean {
  const perfil = (request.user as { perfil?: string } | undefined)?.perfil
  return perfil === 'ADMIN' || perfil === 'GERENTE'
}
