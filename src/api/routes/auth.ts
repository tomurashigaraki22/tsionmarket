import { createHash, timingSafeEqual } from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import type { Environment } from '../../config/env.js'
import type { AuthService } from '../../auth/AuthService.js'
import { authenticationMiddleware, requireIdentity } from '../../auth/middleware.js'
import type { RequestContext, SessionTokens } from '../../auth/types.js'
import { asyncHandler } from '../../utils/asyncHandler.js'
import { AppError } from '../../utils/errors.js'

const EmailSchema = z.string().email().max(320)
const PasswordSchema = z.string().min(1).max(1024)
const TokenSchema = z.string().min(32).max(2048)
const VerificationCodeSchema = z.string().regex(/^\d{6}$/)
const RegisterSchema = z
  .object({ email: EmailSchema, password: PasswordSchema, termsVersion: z.string().min(1).max(50) })
  .strict()
const LoginSchema = z.object({ email: EmailSchema, password: PasswordSchema }).strict()
const EmailOnlySchema = z.object({ email: EmailSchema }).strict()
const VerificationCodeOnlySchema = z.object({ token: VerificationCodeSchema }).strict()
const ResetSchema = z.object({ token: TokenSchema, newPassword: PasswordSchema }).strict()
const ChangePasswordSchema = z
  .object({ currentPassword: PasswordSchema, newPassword: PasswordSchema })
  .strict()
const SessionIdSchema = z.string().uuid()

export function authRouter(authService: AuthService, environment: Environment): Router {
  const router = Router()
  const authenticated = authenticationMiddleware(authService)
  const sensitiveLimit = rateLimit({
    windowMs: 15 * 60_000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (request, response) =>
      response.status(429).json({
        success: false,
        error: { code: 'RATE_LIMITED', message: 'Too many authentication attempts' },
        requestId: request.requestId,
      }),
  })

  router.post(
    '/register',
    sensitiveLimit,
    asyncHandler(async (request, response) => {
      const result = await authService.register(
        RegisterSchema.parse(request.body),
        requestContext(request, environment),
      )
      response.status(202).json({ success: true, data: result })
    }),
  )

  router.post(
    '/verify-email',
    sensitiveLimit,
    asyncHandler(async (request, response) => {
      await authService.verifyEmail(
        VerificationCodeOnlySchema.parse(request.body).token,
        requestContext(request, environment),
      )
      response.json({ success: true, data: { verified: true } })
    }),
  )

  router.post(
    '/resend-verification',
    sensitiveLimit,
    asyncHandler(async (request, response) => {
      const result = await authService.resendVerification(
        EmailOnlySchema.parse(request.body).email,
        requestContext(request, environment),
      )
      response.status(202).json({ success: true, data: result })
    }),
  )

  router.post(
    '/login',
    sensitiveLimit,
    asyncHandler(async (request, response) => {
      const input = LoginSchema.parse(request.body)
      const tokens = await authService.login(
        input.email,
        input.password,
        requestContext(request, environment),
      )
      setSessionCookies(response, tokens, environment)
      response.json({ success: true, data: accessResponse(tokens) })
    }),
  )

  router.post(
    '/refresh',
    sensitiveLimit,
    asyncHandler(async (request, response) => {
      assertAllowedOrigin(request, environment)
      const refreshToken = request.cookies[environment.AUTH_COOKIE_NAME] as unknown
      const csrfCookie = request.cookies[environment.AUTH_CSRF_COOKIE_NAME] as unknown
      const csrfHeader = request.header('x-csrf-token')
      if (
        typeof refreshToken !== 'string' ||
        typeof csrfCookie !== 'string' ||
        !csrfHeader ||
        !safeEqual(csrfCookie, csrfHeader)
      ) {
        throw new AppError('CSRF_VALIDATION_FAILED', 'Request could not be validated', 403)
      }
      const tokens = await authService.refresh(refreshToken, csrfHeader, requestContext(request, environment))
      setSessionCookies(response, tokens, environment)
      response.json({ success: true, data: accessResponse(tokens) })
    }),
  )

  router.post(
    '/logout',
    authenticated,
    asyncHandler(async (request, response) => {
      await authService.logout(requireIdentity(request), requestContext(request, environment))
      clearSessionCookies(response, environment)
      response.json({ success: true, data: { loggedOut: true } })
    }),
  )

  router.post(
    '/logout-all',
    authenticated,
    asyncHandler(async (request, response) => {
      await authService.logoutAll(requireIdentity(request), requestContext(request, environment))
      clearSessionCookies(response, environment)
      response.json({ success: true, data: { loggedOut: true } })
    }),
  )

  router.get(
    '/sessions',
    authenticated,
    asyncHandler(async (request, response) => {
      response.json({
        success: true,
        data: { sessions: await authService.listSessions(requireIdentity(request)) },
      })
    }),
  )

  router.delete(
    '/sessions/:sessionId',
    authenticated,
    asyncHandler(async (request, response) => {
      const sessionId = SessionIdSchema.parse(request.params.sessionId)
      await authService.revokeSession(
        requireIdentity(request),
        sessionId,
        requestContext(request, environment),
      )
      response.json({ success: true, data: { revoked: true } })
    }),
  )

  router.post(
    '/forgot-password',
    sensitiveLimit,
    asyncHandler(async (request, response) => {
      const result = await authService.forgotPassword(
        EmailOnlySchema.parse(request.body).email,
        requestContext(request, environment),
      )
      response.status(202).json({ success: true, data: result })
    }),
  )

  router.post(
    '/reset-password',
    sensitiveLimit,
    asyncHandler(async (request, response) => {
      const input = ResetSchema.parse(request.body)
      await authService.resetPassword(input.token, input.newPassword, requestContext(request, environment))
      clearSessionCookies(response, environment)
      response.json({ success: true, data: { reset: true } })
    }),
  )

  router.post(
    '/change-password',
    authenticated,
    sensitiveLimit,
    asyncHandler(async (request, response) => {
      const input = ChangePasswordSchema.parse(request.body)
      await authService.changePassword(
        requireIdentity(request),
        input.currentPassword,
        input.newPassword,
        requestContext(request, environment),
      )
      clearSessionCookies(response, environment)
      response.json({ success: true, data: { changed: true, reauthenticationRequired: true } })
    }),
  )

  router.get('/me', authenticated, (request, response) => {
    const identity = requireIdentity(request)
    response.json({
      success: true,
      data: { user: { id: identity.userId, email: identity.email }, sessionId: identity.sessionId },
    })
  })

  return router
}

function requestContext(request: Request, environment: Environment): RequestContext {
  return {
    requestId: request.requestId,
    ipHash: request.ip
      ? createHash('sha256').update(`${request.ip}\u0000${environment.AUTH_CHALLENGE_PEPPER}`).digest('hex')
      : null,
    userAgent: request.header('user-agent')?.slice(0, 500) ?? null,
  }
}

function setSessionCookies(response: Response, tokens: SessionTokens, environment: Environment): void {
  const secure = environment.NODE_ENV === 'staging' || environment.NODE_ENV === 'production'
  const common = {
    secure,
    sameSite: 'strict' as const,
    domain: environment.AUTH_COOKIE_DOMAIN,
    path: '/v1/auth',
    maxAge: environment.AUTH_REFRESH_IDLE_TTL_SECONDS * 1000,
  }
  response.cookie(environment.AUTH_COOKIE_NAME, tokens.refreshToken, { ...common, httpOnly: true })
  response.cookie(environment.AUTH_CSRF_COOKIE_NAME, tokens.csrfToken, { ...common, httpOnly: false })
}

function clearSessionCookies(response: Response, environment: Environment): void {
  const options = { domain: environment.AUTH_COOKIE_DOMAIN, path: '/v1/auth' }
  response.clearCookie(environment.AUTH_COOKIE_NAME, options)
  response.clearCookie(environment.AUTH_CSRF_COOKIE_NAME, options)
}

function accessResponse(tokens: SessionTokens) {
  return {
    accessToken: tokens.accessToken,
    tokenType: 'Bearer',
    expiresIn: tokens.accessTokenExpiresIn,
    sessionId: tokens.sessionId,
  }
}

function assertAllowedOrigin(request: Request, environment: Environment): void {
  const origin = request.header('origin')
  if (!origin || !environment.CORS_ALLOWED_ORIGINS.includes(origin)) {
    throw new AppError('CSRF_VALIDATION_FAILED', 'Request could not be validated', 403)
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}
