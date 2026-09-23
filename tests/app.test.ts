import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { parseEnvironment } from '../src/config/env.js'

const environment = parseEnvironment({
  NODE_ENV: 'test',
  MYSQL_HOST: 'localhost',
  MYSQL_DATABASE: 'tsionmarket_test',
  MYSQL_USER: 'app',
  MYSQL_PASSWORD: 'password',
  MYSQL_MIGRATION_USER: 'migration',
  MYSQL_MIGRATION_PASSWORD: 'password',
  CORS_ALLOWED_ORIGINS: 'https://app.tsionmarket.test',
})

describe('HTTP foundation', () => {
  it('returns liveness with a generated request ID and security headers', async () => {
    const app = createApp({
      environment,
      readinessCheck: async () => ({ ready: true, checks: { mysql: 'ready', migrations: 'current' } }),
    })
    const response = await request(app).get('/health')
    expect(response.status).toBe(200)
    expect(response.headers['x-request-id']).toMatch(/^[a-f0-9-]{36}$/)
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    expect(response.body.success).toBe(true)
  })

  it('propagates a safe caller request ID', async () => {
    const app = createApp({
      environment,
      readinessCheck: async () => ({ ready: true, checks: { mysql: 'ready', migrations: 'current' } }),
    })
    const response = await request(app).get('/health').set('x-request-id', 'client-request-123')
    expect(response.headers['x-request-id']).toBe('client-request-123')
  })

  it('allows configured CORS origins and denies unknown origins', async () => {
    const app = createApp({
      environment,
      readinessCheck: async () => ({ ready: true, checks: { mysql: 'ready', migrations: 'current' } }),
    })
    const allowed = await request(app).get('/health').set('origin', 'https://app.tsionmarket.test')
    expect(allowed.headers['access-control-allow-origin']).toBe('https://app.tsionmarket.test')
    const denied = await request(app).get('/health').set('origin', 'https://evil.example')
    expect(denied.status).toBe(403)
    expect(denied.body.error.code).toBe('CORS_ORIGIN_DENIED')
  })

  it('fails readiness without exposing internal details', async () => {
    const app = createApp({
      environment,
      readinessCheck: async () => ({
        ready: false,
        checks: { mysql: 'unavailable', migrations: 'unknown' },
        reason: 'Database unavailable',
      }),
    })
    const response = await request(app).get('/ready')
    expect(response.status).toBe(503)
    expect(response.body.error.code).toBe('SERVICE_NOT_READY')
    expect(response.body.data.checks.mysql).toBe('unavailable')
  })

  it('uses the structured error envelope for unknown routes', async () => {
    const app = createApp({
      environment,
      readinessCheck: async () => ({ ready: true, checks: { mysql: 'ready', migrations: 'current' } }),
    })
    const response = await request(app).get('/does-not-exist')
    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } })
    expect(response.body.requestId).toBe(response.headers['x-request-id'])
  })

  it('serves the read-only market catalogue without authentication', async () => {
    const marketRepository = {
      browse: async () => ({
        items: [{ marketId: '0x:ethereum-mainnet:weth:usdc' }],
        nextCursor: null,
        stale: false,
        lastSuccessfulSync: new Date().toISOString(),
      }),
    }
    const app = createApp({
      environment,
      readinessCheck: async () => ({
        ready: true,
        checks: { mysql: 'ready', migrations: 'current' },
      }),
      marketRepository: marketRepository as never,
    })
    const response = await request(app).get('/v1/markets')
    expect(response.status).toBe(200)
    expect(response.body.data.items[0].marketId).toBe('0x:ethereum-mainnet:weth:usdc')
  })
})
