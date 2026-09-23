import { randomUUID } from 'node:crypto'
import type { Environment } from '../config/env.js'
import { AppError } from '../utils/errors.js'
import type { AuthRepository, NewChallenge, NewSession } from './AuthRepository.js'
import { keyedHash, normalizeEmail, randomOtp, randomToken } from './crypto.js'
import type { EmailService } from './EmailService.js'
import { PasswordService } from './PasswordService.js'
import { TokenService } from './TokenService.js'
import type { AuthIdentity, AuthUser, RequestContext, SessionTokens, SessionView } from './types.js'

const GENERIC_ACCEPTED = { accepted: true } as const

export class AuthService {
  private readonly passwordService: PasswordService
  private readonly tokenService: TokenService
  private readonly dummyPasswordHash: Promise<string>

  constructor(
    private readonly repository: AuthRepository,
    private readonly emailService: EmailService,
    private readonly environment: Environment,
  ) {
    this.passwordService = new PasswordService(environment.AUTH_PASSWORD_PEPPER)
    this.tokenService = new TokenService(environment)
    this.dummyPasswordHash = this.passwordService.hash('tsionmarket constant-time dummy credential')
  }

  async register(input: { email: string; password: string; termsVersion: string }, context: RequestContext) {
    if (input.termsVersion !== this.environment.AUTH_TERMS_VERSION) {
      throw new AppError('TERMS_VERSION_REQUIRED', 'The current terms must be accepted', 400)
    }
    const email = normalizeEmail(input.email)
    const passwordHash = await this.passwordService.hash(input.password)
    const rawToken = randomOtp()
    const challenge = this.challenge('verify_email', rawToken, this.environment.AUTH_VERIFICATION_TTL_SECONDS)
    const userId = randomUUID()
    const created = await this.repository.register({
      userId,
      email,
      passwordHash,
      termsVersion: input.termsVersion,
      challenge,
    })
    if (created) {
      await this.emailService.send({
        to: email,
        purpose: 'verify_email',
        token: rawToken,
        expiresInSeconds: this.environment.AUTH_VERIFICATION_TTL_SECONDS,
      })
      await this.repository.securityEvent('auth.register', 'accepted', context, userId)
    } else {
      await this.repository.securityEvent('auth.register', 'duplicate_masked', context)
    }
    return { ...GENERIC_ACCEPTED, ...this.developmentToken(rawToken, created) }
  }

  async resendVerification(emailInput: string, context: RequestContext) {
    const email = normalizeEmail(emailInput)
    const user = await this.repository.findUserByEmail(email)
    let rawToken: string | undefined
    if (user?.status === 'pending_verification') {
      rawToken = randomOtp()
      const challenge = this.challenge(
        'verify_email',
        rawToken,
        this.environment.AUTH_VERIFICATION_TTL_SECONDS,
      )
      await this.repository.createChallenge(user.id, challenge)
      await this.emailService.send({
        to: email,
        purpose: 'verify_email',
        token: rawToken,
        expiresInSeconds: this.environment.AUTH_VERIFICATION_TTL_SECONDS,
      })
      await this.repository.securityEvent('auth.verification_resend', 'accepted', context, user.id)
    }
    return { ...GENERIC_ACCEPTED, ...this.developmentToken(rawToken, Boolean(rawToken)) }
  }

  async verifyEmail(rawToken: string, context: RequestContext): Promise<void> {
    const consumed = await this.repository.consumeVerification(this.challengeHash(rawToken))
    if (!consumed) {
      await this.repository.securityEvent('auth.email_verify', 'rejected', context)
      throw new AppError('CHALLENGE_INVALID', 'Verification challenge is invalid or expired', 400)
    }
    await this.repository.securityEvent('auth.email_verify', 'succeeded', context)
  }

  async login(emailInput: string, password: string, context: RequestContext): Promise<SessionTokens> {
    const email = normalizeEmail(emailInput)
    const user = await this.repository.findUserByEmail(email)
    if (!user) {
      await this.passwordService.verify(await this.dummyPasswordHash, password)
      await this.repository.securityEvent('auth.login', 'rejected', context)
      throw invalidCredentials()
    }

    const passwordValid = await this.passwordService.verify(user.passwordHash, password)
    const locked = Boolean(user.lockedUntil && Date.parse(user.lockedUntil) > Date.now())
    if (!passwordValid || locked || user.status === 'locked') {
      if (!locked) {
        await this.repository.recordLoginFailure(
          user.id,
          this.environment.AUTH_MAX_LOGIN_FAILURES,
          this.environment.AUTH_LOCKOUT_SECONDS,
        )
      }
      await this.repository.securityEvent('auth.login', 'rejected', context, user.id)
      throw invalidCredentials()
    }
    if (user.status !== 'active' || !user.emailVerifiedAt) {
      await this.repository.securityEvent('auth.login', 'unavailable', context, user.id)
      throw new AppError('ACCOUNT_UNAVAILABLE', 'Account is not available for login', 403)
    }

    const replacementHash = this.passwordService.needsRehash(user.passwordHash)
      ? await this.passwordService.hash(password)
      : undefined
    await this.repository.recordLoginSuccess(user.id, replacementHash)
    const tokens = await this.createSession(user, context)
    await this.repository.securityEvent('auth.login', 'succeeded', context, user.id, tokens.sessionId)
    return tokens
  }

  async refresh(refreshToken: string, csrfToken: string, context: RequestContext): Promise<SessionTokens> {
    const rawNextRefresh = randomToken(48)
    const rawNextCsrf = randomToken()
    const next = this.newSession(
      '',
      '',
      rawNextRefresh,
      rawNextCsrf,
      context,
      new Date(Date.now() + this.environment.AUTH_REFRESH_ABSOLUTE_TTL_SECONDS * 1000),
    )
    const result = await this.repository.rotateSession(
      keyedHash(refreshToken, this.environment.AUTH_REFRESH_TOKEN_PEPPER),
      keyedHash(csrfToken, this.environment.AUTH_REFRESH_TOKEN_PEPPER),
      next,
    )
    if (result.outcome === 'reused') {
      await this.repository.securityEvent('auth.refresh', 'reuse_detected', context)
      throw new AppError('TOKEN_REUSE_DETECTED', 'Session token reuse detected', 401)
    }
    if (result.outcome === 'invalid') {
      await this.repository.securityEvent('auth.refresh', 'rejected', context)
      throw new AppError('SESSION_INVALID', 'Session is invalid or expired', 401)
    }
    const accessToken = await this.tokenService.signAccessToken({
      userId: result.user.id,
      sessionId: next.id,
      tokenVersion: result.user.tokenVersion,
    })
    await this.repository.securityEvent('auth.refresh', 'succeeded', context, result.user.id, next.id)
    return {
      accessToken,
      accessTokenExpiresIn: this.environment.AUTH_ACCESS_TOKEN_TTL_SECONDS,
      refreshToken: rawNextRefresh,
      csrfToken: rawNextCsrf,
      sessionId: next.id,
    }
  }

  async authenticate(accessToken: string): Promise<AuthIdentity> {
    const claims = await this.tokenService.verifyAccessToken(accessToken)
    const identity = await this.repository.findActiveIdentity(claims.userId, claims.sessionId)
    if (!identity || identity.tokenVersion !== claims.tokenVersion) {
      throw new AppError('AUTH_REQUIRED', 'Authentication required', 401)
    }
    return identity
  }

  async logout(identity: AuthIdentity, context: RequestContext): Promise<void> {
    await this.repository.revokeSession(identity.userId, identity.sessionId, 'logout')
    await this.repository.securityEvent(
      'auth.logout',
      'succeeded',
      context,
      identity.userId,
      identity.sessionId,
    )
  }

  async logoutAll(identity: AuthIdentity, context: RequestContext): Promise<void> {
    await this.repository.revokeAllSessions(identity.userId, 'logout_all')
    await this.repository.securityEvent(
      'auth.logout_all',
      'succeeded',
      context,
      identity.userId,
      identity.sessionId,
    )
  }

  async listSessions(identity: AuthIdentity): Promise<SessionView[]> {
    return this.repository.listSessions(identity.userId, identity.sessionId)
  }

  async revokeSession(identity: AuthIdentity, sessionId: string, context: RequestContext): Promise<void> {
    await this.repository.revokeSession(identity.userId, sessionId, 'user_revoked')
    await this.repository.securityEvent(
      'auth.session_revoke',
      'succeeded',
      context,
      identity.userId,
      sessionId,
    )
  }

  async forgotPassword(emailInput: string, context: RequestContext) {
    const email = normalizeEmail(emailInput)
    const user = await this.repository.findUserByEmail(email)
    let rawToken: string | undefined
    if (user && user.status === 'active') {
      rawToken = randomToken()
      await this.repository.createChallenge(
        user.id,
        this.challenge('reset_password', rawToken, this.environment.AUTH_RESET_TTL_SECONDS),
      )
      await this.emailService.send({
        to: email,
        purpose: 'reset_password',
        token: rawToken,
        expiresInSeconds: this.environment.AUTH_RESET_TTL_SECONDS,
      })
      await this.repository.securityEvent('auth.password_forgot', 'accepted', context, user.id)
    }
    return { ...GENERIC_ACCEPTED, ...this.developmentToken(rawToken, Boolean(rawToken)) }
  }

  async resetPassword(rawToken: string, newPassword: string, context: RequestContext): Promise<void> {
    const passwordHash = await this.passwordService.hash(newPassword)
    const consumed = await this.repository.consumePasswordReset(this.challengeHash(rawToken), passwordHash)
    if (!consumed) {
      await this.repository.securityEvent('auth.password_reset', 'rejected', context)
      throw new AppError('CHALLENGE_INVALID', 'Password reset challenge is invalid or expired', 400)
    }
    await this.repository.securityEvent('auth.password_reset', 'succeeded', context)
  }

  async changePassword(
    identity: AuthIdentity,
    currentPassword: string,
    newPassword: string,
    context: RequestContext,
  ): Promise<void> {
    if (currentPassword === newPassword) {
      throw new AppError('PASSWORD_POLICY_FAILED', 'New password must differ from the current password', 400)
    }
    const user = await this.repository.findUserByEmail(identity.email)
    if (!user || !(await this.passwordService.verify(user.passwordHash, currentPassword))) {
      throw invalidCredentials()
    }
    const passwordHash = await this.passwordService.hash(newPassword)
    await this.repository.changePassword(identity.userId, passwordHash)
    await this.repository.securityEvent(
      'auth.password_change',
      'succeeded',
      context,
      identity.userId,
      identity.sessionId,
    )
  }

  private async createSession(
    user: Pick<AuthUser, 'id' | 'email' | 'tokenVersion'>,
    context: RequestContext,
  ): Promise<SessionTokens> {
    const refreshToken = randomToken(48)
    const csrfToken = randomToken()
    const absoluteExpiresAt = new Date(Date.now() + this.environment.AUTH_REFRESH_ABSOLUTE_TTL_SECONDS * 1000)
    const session = this.newSession(
      user.id,
      randomUUID(),
      refreshToken,
      csrfToken,
      context,
      absoluteExpiresAt,
    )
    await this.repository.createSession(session)
    return {
      accessToken: await this.tokenService.signAccessToken({
        userId: user.id,
        sessionId: session.id,
        tokenVersion: user.tokenVersion,
      }),
      accessTokenExpiresIn: this.environment.AUTH_ACCESS_TOKEN_TTL_SECONDS,
      refreshToken,
      csrfToken,
      sessionId: session.id,
    }
  }

  private newSession(
    userId: string,
    familyId: string,
    refreshToken: string,
    csrfToken: string,
    context: RequestContext,
    absoluteExpiresAt: Date,
  ): NewSession {
    const expiresAt = new Date(
      Math.min(
        Date.now() + this.environment.AUTH_REFRESH_IDLE_TTL_SECONDS * 1000,
        absoluteExpiresAt.getTime(),
      ),
    )
    return {
      id: randomUUID(),
      userId,
      familyId,
      refreshHash: keyedHash(refreshToken, this.environment.AUTH_REFRESH_TOKEN_PEPPER),
      csrfHash: keyedHash(csrfToken, this.environment.AUTH_REFRESH_TOKEN_PEPPER),
      expiresAt,
      absoluteExpiresAt,
      context,
    }
  }

  private challenge(purpose: NewChallenge['purpose'], rawToken: string, ttlSeconds: number): NewChallenge {
    return {
      id: randomUUID(),
      purpose,
      tokenHash: this.challengeHash(rawToken),
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    }
  }

  private challengeHash(rawToken: string): string {
    return keyedHash(rawToken, this.environment.AUTH_CHALLENGE_PEPPER)
  }

  private developmentToken(token: string | undefined, issued: boolean): Record<string, string> {
    return issued && token && ['development', 'test'].includes(this.environment.NODE_ENV)
      ? { developmentChallengeToken: token }
      : {}
  }
}

function invalidCredentials(): AppError {
  return new AppError('INVALID_CREDENTIALS', 'Invalid email or password', 401)
}
