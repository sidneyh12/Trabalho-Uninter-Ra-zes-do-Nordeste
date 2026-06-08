import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

export function hashPassword(plainTextPassword: string): string {
  const salt = randomBytes(16).toString('hex')
  const derivedKey = scryptSync(plainTextPassword, salt, 64).toString('hex')
  return `scrypt$${salt}$${derivedKey}`
}

export function verifyPassword(
  plainTextPassword: string,
  storedHash: string,
): boolean {
  const [algorithm, salt, savedHash] = storedHash.split('$')

  if (algorithm !== 'scrypt' || !salt || !savedHash) {
    return false
  }

  const derivedKey = scryptSync(
    plainTextPassword,
    salt,
    savedHash.length / 2,
  ).toString('hex')

  return timingSafeEqual(
    Buffer.from(derivedKey, 'hex'),
    Buffer.from(savedHash, 'hex'),
  )
}
