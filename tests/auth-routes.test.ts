import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import type { AuthService } from '../src/auth/AuthService.js'
import { parseEnvironment } from '../src/config/env.js'

const environment = parseEnvironment({
  NODE_ENV: 'test',
  MYSQL_HOST: 'localhost',
  MYSQL_DATABASE: 'test',
  MYSQL_USER: 'app',
  MYSQL_PASSWORD: 'password',
  MYSQL_MIGRATION_USER: 'migration',
  MYSQL_MIGRATION_PASSWORD: 'password',
  CORS_ALLOWED_ORIGINS: 'https://app.test',
})

function appWithAuth(overrides: Record<string, unknown> = {}) {
  const service = {
    register: vi.fn().mockResolvedValue({ accepted: true }),
    login: vi.fn().mockResolvedValue({
      accessToken: 'signed-access-token',
      accessTokenExpiresIn: 900,
      refreshToken: 'refresh-value',
      csrfToken: 'csrf-value',
      sessionId: '9d17d9d6-5847-4ac7-89fa-42a003a66ee8',
    }),
    refresh: vi.fn().mockResolvedValue({
      accessToken: 'rotated-access-token',
      accessTokenExpiresIn: 900,
      refreshToken: 'rotated-refresh',
      csrfToken: 'rotated-csrf',
      sessionId: 'a3152186-401f-4c58-bd49-c0615765683f',
    }),
    authenticate: vi.fn().mockResolvedValue({
      userId: '74ea7c09-27c0-46d1-9f06-653e08740613',
      sessionId: '9d17d9d6-5847-4ac7-89fa-42a003a66ee8',
      email: 'user@example.com',
      tokenVersion: 1,
    }),
    ...overrides,
  } as unknown as AuthService
  return {
    service,
    app: createApp({
      environment,
      readinessCheck: async () => ({ ready: true, checks: { mysql: 'ready', migrations: 'current' } }),
      authService: service,
    }),
  }
}

describe('authentication routes', () => {
  it('accepts a strict registration payload', async () => {
    const { app, service } = appWithAuth()
    const response = await request(app).post('/v1/auth/register').send({
      email: 'user@example.com',
      password: 'a sufficiently long password',
      termsVersion: environment.AUTH_TERMS_VERSION,
    })
    expect(response.status).toBe(202)
    expect(response.body.data.accepted).toBe(true)
    expect(service.register).toHaveBeenCalledOnce()
  })

  it('rejects unknown sensitive fields', async () => {
    const { app } = appWithAuth()
    const response = await request(app).post('/v1/auth/register').send({
      email: 'user@example.com',
      password: 'a sufficiently long password',
      termsVersion: environment.AUTH_TERMS_VERSION,
      privateKey: 'never',
    })
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('sets HttpOnly refresh and readable CSRF cookies on login', async () => {
    const { app } = appWithAuth()
    const response = await request(app)
      .post('/v1/auth/login')
      .send({ email: 'user@example.com', password: 'a sufficiently long password' })
    expect(response.status).toBe(200)
    const cookies = response.headers['set-cookie'] as unknown as string[]
    expect(cookies.some((cookie) => cookie.startsWith('tsion_refresh=') && cookie.includes('HttpOnly'))).toBe(
      true,
    )
    expect(cookies.some((cookie) => cookie.startsWith('tsion_csrf=') && !cookie.includes('HttpOnly'))).toBe(
      true,
    )
    expect(response.body.data).not.toHaveProperty('refreshToken')
  })

  it('requires an allowed Origin and matching double-submit CSRF token for refresh', async () => {
    const { app, service } = appWithAuth()
    const denied = await request(app)
      .post('/v1/auth/refresh')
      .set('Cookie', ['tsion_refresh=refresh-value', 'tsion_csrf=csrf-value'])
      .set('x-csrf-token', 'csrf-value')
    expect(denied.status).toBe(403)

    const accepted = await request(app)
      .post('/v1/auth/refresh')
      .set('Origin', 'https://app.test')
      .set('Cookie', ['tsion_refresh=refresh-value', 'tsion_csrf=csrf-value'])
      .set('x-csrf-token', 'csrf-value')
    expect(accepted.status).toBe(200)
    expect(service.refresh).toHaveBeenCalledWith('refresh-value', 'csrf-value', expect.any(Object))
  })

  it('fails closed for every unmounted /v1 route', async () => {
    const { app } = appWithAuth()
    const response = await request(app).get('/v1/private-resource')
    expect(response.status).toBe(401)
    expect(response.body.error.code).toBe('AUTH_REQUIRED')
  })
})
