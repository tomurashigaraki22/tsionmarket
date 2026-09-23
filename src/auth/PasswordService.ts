import argon2 from 'argon2'
import { AppError } from '../utils/errors.js'

const COMMON_PASSWORDS = new Set([
  'password1234',
  '123456789012',
  'qwertyuiop12',
  'letmein123456',
  'admin12345678',
])

export class PasswordService {
  constructor(private readonly pepper: string) {}

  validate(password: string): void {
    if (password.length < 12 || password.length > 1024) {
      throw new AppError('PASSWORD_POLICY_FAILED', 'Password must be between 12 and 1024 characters', 400)
    }
    if (COMMON_PASSWORDS.has(password.toLowerCase())) {
      throw new AppError('PASSWORD_POLICY_FAILED', 'Choose a password that is not commonly compromised', 400)
    }
  }

  async hash(password: string): Promise<string> {
    this.validate(password)
    return argon2.hash(this.peppered(password), {
      type: argon2.argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
    })
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, this.peppered(password))
    } catch {
      return false
    }
  }

  needsRehash(hash: string): boolean {
    return argon2.needsRehash(hash, { memoryCost: 65_536, timeCost: 3, parallelism: 1 })
  }

  private peppered(password: string): string {
    return `${password}\u0000${this.pepper}`
  }
}
