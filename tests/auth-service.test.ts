import { describe, expect, it, vi } from 'vitest'
import { AuthService } from '../src/auth/AuthService.js'
import type { AuthRepository } from '../src/auth/AuthRepository.js'
import { PasswordService } from '../src/auth/PasswordService.js'
import { TokenService } from '../src/auth/TokenService.js'
import { parseEnvironment } from '../src/config/env.js'

const environment = parseEnvironment({
  NODE_ENV: 'test',
  MYSQL_HOST: 'localhost',
  MYSQL_DATABASE: 'test',
  MYSQL_USER: 'app',
  MYSQL_PASSWORD: 'password',
  MYSQL_MIGRATION_USER: 'migration',
  MYSQL_MIGRATION_PASSWORD: 'password',
})
const context = { requestId: 'request-1', ipHash: null, userAgent: 'test' }

describe('authentication service security behavior', () => {
  it('masks duplicate registration and does not send another email', async () => {
    const repository = {
      register: vi.fn().mockResolvedValue(false),
      securityEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as AuthRepository
    const email = { send: vi.fn().mockResolvedValue(undefined) }
    const service = new AuthService(repository, email, environment)
    const result = await service.register(
      {
        email: ' User@Example.com ',
        password: 'a uniquely strong password',
        termsVersion: environment.AUTH_TERMS_VERSION,
      },
      context,
    )
    expect(result).toEqual({ accepted: true })
    expect(email.send).not.toHaveBeenCalled()
    expect(repository.register).toHaveBeenCalledWith(expect.objectContaining({ email: 'user@example.com' }))
  })

  it('treats refresh-token reuse as a security failure', async () => {
    const repository = {
      rotateSession: vi.fn().mockResolvedValue({ outcome: 'reused' }),
      securityEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as AuthRepository
    const service = new AuthService(repository, { send: vi.fn() }, environment)
    await expect(service.refresh('old-refresh', 'csrf', context)).rejects.toMatchObject({
      code: 'TOKEN_REUSE_DETECTED',
      statusCode: 401,
    })
    expect(repository.securityEvent).toHaveBeenCalledWith('auth.refresh', 'reuse_detected', context)
  })

  it('refuses login until the email address is verified', async () => {
    const password = 'a uniquely strong password'
    const passwordHash = await new PasswordService(environment.AUTH_PASSWORD_PEPPER).hash(password)
    const repository = {
      findUserByEmail: vi.fn().mockResolvedValue({
        id: 'cf84f7e2-71cb-46ef-8194-79f0c27951da',
        email: 'user@example.com',
        status: 'pending_verification',
        emailVerifiedAt: null,
        tokenVersion: 0,
        failedLoginCount: 0,
        lockedUntil: null,
        passwordHash,
      }),
      recordLoginFailure: vi.fn().mockResolvedValue(undefined),
      securityEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as AuthRepository
    const service = new AuthService(repository, { send: vi.fn() }, environment)

    await expect(service.login('user@example.com', password, context)).rejects.toMatchObject({
      code: 'ACCOUNT_UNAVAILABLE',
      statusCode: 403,
    })
  })

  it('rejects stale token versions even when the JWT signature is valid', async () => {
    const repository = {
      createSession: vi.fn().mockResolvedValue(undefined),
      findActiveIdentity: vi.fn().mockResolvedValue({
        userId: 'cf84f7e2-71cb-46ef-8194-79f0c27951da',
        sessionId: 'fa9ec0a6-bfc9-4873-b7c2-a4919fed8ed5',
        email: 'user@example.com',
        tokenVersion: 2,
      }),
    } as unknown as AuthRepository
    const service = new AuthService(repository, { send: vi.fn() }, environment)
    const token = await new TokenService(environment).signAccessToken({
      userId: 'cf84f7e2-71cb-46ef-8194-79f0c27951da',
      sessionId: 'fa9ec0a6-bfc9-4873-b7c2-a4919fed8ed5',
      tokenVersion: 1,
    })
    await expect(service.authenticate(token)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
  })
})
