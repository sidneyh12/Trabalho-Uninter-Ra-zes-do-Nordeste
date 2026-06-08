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
