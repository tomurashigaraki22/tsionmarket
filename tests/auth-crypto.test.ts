import { describe, expect, it } from 'vitest'
import { PasswordService } from '../src/auth/PasswordService.js'
import { TokenService } from '../src/auth/TokenService.js'
import { keyedHash, normalizeEmail, randomToken } from '../src/auth/crypto.js'
import { parseEnvironment } from '../src/config/env.js'

const environment = parseEnvironment({
  NODE_ENV: 'test',
  MYSQL_HOST: 'localhost',
  MYSQL_DATABASE: 'test',
  MYSQL_USER: 'app',
  MYSQL_PASSWORD: 'password',
  MYSQL_MIGRATION_USER: 'migration',
  MYSQL_MIGRATION_PASSWORD: 'password',
  AUTH_ACCESS_TOKEN_SECRET: 'test-access-token-secret-at-least-32-bytes',
  AUTH_PASSWORD_PEPPER: 'test-password-pepper-at-least-32-bytes',
  AUTH_REFRESH_TOKEN_PEPPER: 'test-refresh-pepper-at-least-32-bytes',
  AUTH_CHALLENGE_PEPPER: 'test-challenge-pepper-at-least-32-bytes',
})

describe('authentication cryptography', () => {
  it('hashes passwords with Argon2id and verifies only the correct password', async () => {
    const passwords = new PasswordService(environment.AUTH_PASSWORD_PEPPER)
    const hash = await passwords.hash('a long unique test password')
    expect(hash).toMatch(/^\$argon2id\$/)
    await expect(passwords.verify(hash, 'a long unique test password')).resolves.toBe(true)
    await expect(passwords.verify(hash, 'the wrong password')).resolves.toBe(false)
  })

  it('rejects short and known weak passwords', () => {
    const passwords = new PasswordService(environment.AUTH_PASSWORD_PEPPER)
    expect(() => passwords.validate('short')).toThrow(/between 12 and 1024/)
    expect(() => passwords.validate('password1234')).toThrow(/commonly compromised/)
  })

  it('signs and validates scoped access tokens', async () => {
    const tokens = new TokenService(environment)
    const token = await tokens.signAccessToken({
      userId: '3f6a3652-2ec9-44db-9d5a-2cc4bc9dc677',
      sessionId: 'd4096325-51f8-436d-97e9-18dd758fbeba',
      tokenVersion: 3,
    })
    await expect(tokens.verifyAccessToken(token)).resolves.toMatchObject({
      userId: '3f6a3652-2ec9-44db-9d5a-2cc4bc9dc677',
      sessionId: 'd4096325-51f8-436d-97e9-18dd758fbeba',
      tokenVersion: 3,
    })
    const wrongKey = new TokenService(
      parseEnvironment({
        ...environmentAsInput(),
        AUTH_ACCESS_TOKEN_SECRET: 'a-different-test-secret-at-least-32-bytes',
      }),
    )
    await expect(wrongKey.verifyAccessToken(token)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
  })

  it('normalizes email and produces non-reversible keyed hashes', () => {
    expect(normalizeEmail('  User@Example.COM ')).toBe('user@example.com')
    const token = randomToken(48)
    expect(token).not.toContain('=')
    expect(keyedHash(token, environment.AUTH_REFRESH_TOKEN_PEPPER)).toMatch(/^[a-f0-9]{64}$/)
  })
})

function environmentAsInput(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    MYSQL_HOST: 'localhost',
    MYSQL_DATABASE: 'test',
    MYSQL_USER: 'app',
    MYSQL_PASSWORD: 'password',
    MYSQL_MIGRATION_USER: 'migration',
    MYSQL_MIGRATION_PASSWORD: 'password',
    AUTH_PASSWORD_PEPPER: 'test-password-pepper-at-least-32-bytes',
    AUTH_REFRESH_TOKEN_PEPPER: 'test-refresh-pepper-at-least-32-bytes',
    AUTH_CHALLENGE_PEPPER: 'test-challenge-pepper-at-least-32-bytes',
  }
}
