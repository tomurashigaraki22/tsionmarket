import { createHmac, randomBytes, randomInt } from 'node:crypto'

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function randomOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0')
}

export function keyedHash(value: string, pepper: string): string {
  return createHmac('sha256', pepper).update(value).digest('hex')
}

export function normalizeEmail(email: string): string {
  return email.trim().normalize('NFKC').toLowerCase()
}
