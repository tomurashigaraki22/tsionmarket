import { describe, expect, it } from 'vitest'
import { parseEnvironment } from '../src/config/env.js'
import { getOnSwitchRuntimeConfig } from '../src/config/onswitch.js'

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
    expect(environment.ONSWITCH_ENABLED).toBe(false)
    expect(environment.ONSWITCH_ENVIRONMENT).toBe('sandbox')
    expect(getOnSwitchRuntimeConfig(environment)).toBeNull()
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

  it('requires the selected server-side OnSwitch key only when enabled', () => {
    expect(() =>
      parseEnvironment({
        ...validEnvironment,
        ONSWITCH_ENABLED: 'true',
        ONSWITCH_ENVIRONMENT: 'sandbox',
      }),
    ).toThrow(/OnSwitch sandbox mode requires its server-side service key/)

    const environment = parseEnvironment({
      ...validEnvironment,
      ONSWITCH_ENABLED: 'true',
      ONSWITCH_ENVIRONMENT: 'sandbox',
      ONSWITCH_SANDBOX_SERVICE_KEY: 'sandbox-test-secret-not-real',
      ONSWITCH_DATA_ENCRYPTION_KEY: 'e'.repeat(64),
      ONSWITCH_IDEMPOTENCY_SECRET: 'idem-test-secret-with-at-least-32-chars',
    })
    expect(getOnSwitchRuntimeConfig(environment)).toEqual({
      environment: 'sandbox',
      serviceKey: 'sandbox-test-secret-not-real',
      timeoutMs: 10_000,
    })
  })

  it('requires a valid data-encryption key when OnSwitch is enabled', () => {
    const enabledSandbox = {
      ...validEnvironment,
      ONSWITCH_ENABLED: 'true',
      ONSWITCH_ENVIRONMENT: 'sandbox',
      ONSWITCH_SANDBOX_SERVICE_KEY: 'sandbox-test-secret-not-real',
      ONSWITCH_IDEMPOTENCY_SECRET: 'idem-test-secret-with-at-least-32-chars',
    }
    expect(() => parseEnvironment(enabledSandbox)).toThrow(/payment-instructions encryption key/)
    expect(() => parseEnvironment({ ...enabledSandbox, ONSWITCH_DATA_ENCRYPTION_KEY: 'not-hex' })).toThrow()
  })

  it('does not permit OnSwitch live credentials in development or test', () => {
    expect(() =>
      parseEnvironment({
        ...validEnvironment,
        ONSWITCH_ENABLED: 'true',
        ONSWITCH_ENVIRONMENT: 'live',
        ONSWITCH_LIVE_SERVICE_KEY: 'live-test-secret-not-real',
      }),
    ).toThrow(/OnSwitch live mode is allowed only in production/)
  })

  it('does not permit sandbox payment starts in production', () => {
    const productionEnvironment = {
      ...validEnvironment,
      NODE_ENV: 'production',
      AUTH_ACCESS_TOKEN_SECRET: 'a'.repeat(40),
      AUTH_REFRESH_TOKEN_PEPPER: 'b'.repeat(40),
      AUTH_PASSWORD_PEPPER: 'c'.repeat(40),
      AUTH_CHALLENGE_PEPPER: 'd'.repeat(40),
      ONSWITCH_IDEMPOTENCY_SECRET: 'idem-test-secret-with-at-least-32-chars',
      AUTH_EMAIL_DELIVERY_MODE: 'http',
      AUTH_EMAIL_PROVIDER_URL: 'https://mail.example.test/send',
      AUTH_EMAIL_PROVIDER_API_KEY: 'mail-test-secret-not-real',
      MYSQL_PASSWORD: 'app-password-long-enough',
      MYSQL_MIGRATION_PASSWORD: 'migration-password-long-enough',
      MYSQL_MIGRATION_USER: 'migrator',
      METRICS_BEARER_TOKEN: 'm'.repeat(40),
      ONSWITCH_ENABLED: 'true',
      ONSWITCH_ENVIRONMENT: 'sandbox',
      ONSWITCH_SANDBOX_SERVICE_KEY: 'sandbox-test-secret-not-real',
      ONSWITCH_DATA_ENCRYPTION_KEY: 'e'.repeat(64),
    }
    expect(() => parseEnvironment(productionEnvironment)).toThrow(
      /OnSwitch sandbox mode is forbidden in production/,
    )

    const liveEnvironment = parseEnvironment({
      ...productionEnvironment,
      ONSWITCH_ENVIRONMENT: 'live',
      ONSWITCH_LIVE_SERVICE_KEY: 'live-test-secret-not-real',
    })
    expect(getOnSwitchRuntimeConfig(liveEnvironment)).toMatchObject({
      environment: 'live',
      serviceKey: 'live-test-secret-not-real',
    })
  })
})
