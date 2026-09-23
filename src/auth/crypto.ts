import { createHmac, randomBytes } from 'node:crypto'

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function keyedHash(value: string, pepper: string): string {
  return createHmac('sha256', pepper).update(value).digest('hex')
}

export function normalizeEmail(email: string): string {
  return email.trim().normalize('NFKC').toLowerCase()
}
