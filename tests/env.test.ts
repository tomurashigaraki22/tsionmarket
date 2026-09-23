import { describe, expect, it } from 'vitest'
import { parseEnvironment } from '../src/config/env.js'

const validEnvironment = {
  NODE_ENV: 'test',
  MYSQL_HOST: 'localhost',
  MYSQL_DATABASE: 'tsionmarket_test',
  MYSQL_USER: 'app',
  MYSQL_PASSWORD: 'password',
  MYSQL_MIGRATION_USER: 'migration',
  MYSQL_MIGRATION_PASSWORD: 'password',
}

describe('environment validation', () => {
  it('parses a safe test environment', () => {
    const environment = parseEnvironment(validEnvironment)
    expect(environment.MYSQL_DATABASE).toBe('tsionmarket_test')
    expect(environment.AUTH_BYPASS_ENABLED).toBe(false)
  })

  it('rejects auth bypass in production', () => {
    expect(() =>
      parseEnvironment({
        ...validEnvironment,
        NODE_ENV: 'production',
        AUTH_BYPASS_ENABLED: 'true',
        MYSQL_PASSWORD: 'a-strong-app-password',
        MYSQL_MIGRATION_PASSWORD: 'a-strong-migration-password',
      }),
    ).toThrow(/Authentication bypass/)
  })

  it('requires separate strong database credentials in production', () => {
    expect(() =>
      parseEnvironment({ ...validEnvironment, NODE_ENV: 'production', MYSQL_MIGRATION_USER: 'app' }),
    ).toThrow(/password|must differ/)
  })

  it('rejects an unsafe database identifier', () => {
    expect(() =>
      parseEnvironment({ ...validEnvironment, MYSQL_DATABASE: 'database; DROP TABLE users' }),
    ).toThrow()
  })
})
