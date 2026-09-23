import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { randomUUID } from 'node:crypto'
import { withTransaction } from '../db/transaction.js'
import type { AuthIdentity, AuthUser, ChallengePurpose, RequestContext, SessionView } from './types.js'

type AuthUserRow = RowDataPacket & {
  id: string
  email: string
  status: AuthUser['status']
  email_verified_at: string | null
  token_version: number
  failed_login_count: number
  locked_until: string | null
  password_hash: string
}

type ChallengeRow = RowDataPacket & {
  id: string
  user_id: string
  purpose: ChallengePurpose
  expires_at: string
  consumed_at: string | null
  attempts: number
  max_attempts: number
}

type SessionRow = RowDataPacket & {
  id: string
  user_id: string
  token_family_id: string
  csrf_token_hash: string
  expires_at: string
  absolute_expires_at: string
  rotated_at: string | null
  revoked_at: string | null
  email: string
  status: AuthUser['status']
  email_verified_at: string | null
  token_version: number
}

type IdentityRow = RowDataPacket & {
  user_id: string
  session_id: string
  email: string
  token_version: number
  status: AuthUser['status']
  email_verified_at: string | null
}

export type NewChallenge = { id: string; tokenHash: string; expiresAt: Date; purpose: ChallengePurpose }
export type NewSession = {
  id: string
  userId: string
  familyId: string
  refreshHash: string
  csrfHash: string
  expiresAt: Date
  absoluteExpiresAt: Date
  context: RequestContext
}

export type RotateResult =
  | { outcome: 'invalid' }
  | { outcome: 'reused' }
  | {
      outcome: 'rotated'
      user: Pick<AuthUser, 'id' | 'email' | 'status' | 'emailVerifiedAt' | 'tokenVersion'>
    }

export class AuthRepository {
  constructor(
    private readonly pool: Pool,
    private readonly acquisitionTimeoutMs: number,
  ) {}

  async register(input: {
    userId: string
    email: string
    passwordHash: string
    termsVersion: string
    challenge: NewChallenge
  }): Promise<boolean> {
    try {
      await withTransaction(
        this.pool,
        async (connection) => {
          await connection.execute(
            `INSERT INTO users (id, email, terms_version, terms_accepted_at)
             VALUES (?, ?, ?, CURRENT_TIMESTAMP(6))`,
            [input.userId, input.email, input.termsVersion],
          )
          await connection.execute(
            `INSERT INTO user_credentials (user_id, password_hash, hash_version)
             VALUES (?, ?, 1)`,
            [input.userId, input.passwordHash],
          )
          await connection.execute(
            `INSERT INTO auth_challenges (id, user_id, purpose, token_hash, expires_at)
             VALUES (?, ?, ?, ?, ?)`,
            [
              input.challenge.id,
              input.userId,
              input.challenge.purpose,
              input.challenge.tokenHash,
              input.challenge.expiresAt,
            ],
          )
        },
        this.acquisitionTimeoutMs,
      )
      return true
    } catch (error) {
      if (isDuplicateEntry(error)) return false
      throw error
    }
  }

  async findUserByEmail(email: string): Promise<AuthUser | null> {
    const [rows] = await this.pool.execute<AuthUserRow[]>(
      `SELECT u.id, u.email, u.status, u.email_verified_at, u.token_version,
              u.failed_login_count, u.locked_until, c.password_hash
       FROM users u JOIN user_credentials c ON c.user_id = u.id
       WHERE u.email = ? LIMIT 1`,
      [email],
    )
    return rows[0] ? mapAuthUser(rows[0]) : null
  }

  async createChallenge(userId: string, challenge: NewChallenge): Promise<void> {
    await withTransaction(
      this.pool,
      async (connection) => {
        await connection.execute(
          `UPDATE auth_challenges SET consumed_at = CURRENT_TIMESTAMP(6)
           WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL`,
          [userId, challenge.purpose],
        )
        await connection.execute(
          `INSERT INTO auth_challenges (id, user_id, purpose, token_hash, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
          [challenge.id, userId, challenge.purpose, challenge.tokenHash, challenge.expiresAt],
        )
      },
      this.acquisitionTimeoutMs,
    )
  }

  async consumeVerification(tokenHash: string): Promise<boolean> {
    return withTransaction(
      this.pool,
      async (connection) => {
        const [rows] = await connection.execute<ChallengeRow[]>(
          `SELECT c.id, c.user_id, c.purpose, c.expires_at, c.consumed_at, c.attempts, c.max_attempts
           FROM auth_challenges c JOIN users u ON u.id = c.user_id
           WHERE c.token_hash = ? AND c.purpose = 'verify_email'
             AND u.status = 'pending_verification' FOR UPDATE`,
          [tokenHash],
        )
        const challenge = rows[0]
        if (!challenge || !challengeUsable(challenge)) return false
        await connection.execute(
          'UPDATE auth_challenges SET consumed_at = CURRENT_TIMESTAMP(6) WHERE id = ?',
          [challenge.id],
        )
        await connection.execute(
          `UPDATE users SET status = 'active', email_verified_at = CURRENT_TIMESTAMP(6),
                            failed_login_count = 0, locked_until = NULL
           WHERE id = ? AND status = 'pending_verification'`,
          [challenge.user_id],
        )
        return true
      },
      this.acquisitionTimeoutMs,
    )
  }

  async consumePasswordReset(tokenHash: string, passwordHash: string): Promise<boolean> {
    return withTransaction(
      this.pool,
      async (connection) => {
        const [rows] = await connection.execute<ChallengeRow[]>(
          `SELECT c.id, c.user_id, c.purpose, c.expires_at, c.consumed_at, c.attempts, c.max_attempts
           FROM auth_challenges c JOIN users u ON u.id = c.user_id
           WHERE c.token_hash = ? AND c.purpose = 'reset_password' AND u.status = 'active' FOR UPDATE`,
          [tokenHash],
        )
        const challenge = rows[0]
        if (!challenge || !challengeUsable(challenge)) return false
        await connection.execute(
          'UPDATE auth_challenges SET consumed_at = CURRENT_TIMESTAMP(6) WHERE id = ?',
          [challenge.id],
        )
        await connection.execute(
          `UPDATE user_credentials SET password_hash = ?, hash_version = hash_version + 1,
             password_changed_at = CURRENT_TIMESTAMP(6) WHERE user_id = ?`,
          [passwordHash, challenge.user_id],
        )
        await connection.execute(
          `UPDATE users SET token_version = token_version + 1, failed_login_count = 0,
             locked_until = NULL WHERE id = ?`,
          [challenge.user_id],
        )
        await connection.execute(
          `UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP(6), revocation_reason = 'password_reset'
           WHERE user_id = ? AND revoked_at IS NULL`,
          [challenge.user_id],
        )
        return true
      },
      this.acquisitionTimeoutMs,
    )
  }

  async recordLoginFailure(userId: string, maxFailures: number, lockoutSeconds: number): Promise<void> {
    await this.pool.execute(
      `UPDATE users
       SET failed_login_count = failed_login_count + 1,
           locked_until = CASE WHEN failed_login_count + 1 >= ?
             THEN TIMESTAMPADD(SECOND,
               CAST(LEAST(86400, ? * POW(2, GREATEST(0, failed_login_count + 1 - ?))) AS UNSIGNED),
               CURRENT_TIMESTAMP(6))
             ELSE locked_until END
       WHERE id = ?`,
      [maxFailures, lockoutSeconds, maxFailures, userId],
    )
  }

  async recordLoginSuccess(userId: string, replacementHash?: string): Promise<void> {
    await withTransaction(
      this.pool,
      async (connection) => {
        await connection.execute(
          'UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = ?',
          [userId],
        )
        if (replacementHash) {
          await connection.execute(
            'UPDATE user_credentials SET password_hash = ?, hash_version = hash_version + 1 WHERE user_id = ?',
            [replacementHash, userId],
          )
        }
      },
      this.acquisitionTimeoutMs,
    )
  }

  async createSession(session: NewSession): Promise<void> {
    await this.pool.execute(
      `INSERT INTO auth_sessions
       (id, user_id, token_family_id, refresh_token_hash, csrf_token_hash, user_agent, ip_hash, expires_at, absolute_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        session.id,
        session.userId,
        session.familyId,
        session.refreshHash,
        session.csrfHash,
        session.context.userAgent,
        session.context.ipHash,
        session.expiresAt,
        session.absoluteExpiresAt,
      ],
    )
  }

  async rotateSession(oldRefreshHash: string, csrfHash: string, next: NewSession): Promise<RotateResult> {
    return withTransaction(
      this.pool,
      async (connection) => {
        const [rows] = await connection.execute<SessionRow[]>(
          `SELECT s.id, s.user_id, s.token_family_id, s.csrf_token_hash, s.expires_at,
                  s.absolute_expires_at, s.rotated_at, s.revoked_at,
                  u.email, u.status, u.email_verified_at, u.token_version
           FROM auth_sessions s JOIN users u ON u.id = s.user_id
           WHERE s.refresh_token_hash = ? FOR UPDATE`,
          [oldRefreshHash],
        )
        const session = rows[0]
        if (!session) return { outcome: 'invalid' }
        if (session.rotated_at) {
          await connection.execute(
            `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP(6)),
             revocation_reason = 'refresh_reuse' WHERE token_family_id = ?`,
            [session.token_family_id],
          )
          return { outcome: 'reused' }
        }
        const now = Date.now()
        if (
          session.revoked_at ||
          session.csrf_token_hash !== csrfHash ||
          Date.parse(session.expires_at) <= now ||
          Date.parse(session.absolute_expires_at) <= now ||
          session.status !== 'active' ||
          !session.email_verified_at
        ) {
          return { outcome: 'invalid' }
        }
        await connection.execute(
          'UPDATE auth_sessions SET rotated_at = CURRENT_TIMESTAMP(6), last_used_at = CURRENT_TIMESTAMP(6) WHERE id = ?',
          [session.id],
        )
        await connection.execute(
          `INSERT INTO auth_sessions
           (id, user_id, token_family_id, refresh_token_hash, csrf_token_hash, user_agent, ip_hash, expires_at, absolute_expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            next.id,
            session.user_id,
            session.token_family_id,
            next.refreshHash,
            next.csrfHash,
            next.context.userAgent,
            next.context.ipHash,
            new Date(Math.min(next.expiresAt.getTime(), Date.parse(session.absolute_expires_at))),
            new Date(session.absolute_expires_at),
          ],
        )
        return {
          outcome: 'rotated',
          user: {
            id: session.user_id,
            email: session.email,
            status: session.status,
            emailVerifiedAt: session.email_verified_at,
            tokenVersion: session.token_version,
          },
        }
      },
      this.acquisitionTimeoutMs,
    )
  }

  async findActiveIdentity(userId: string, sessionId: string): Promise<AuthIdentity | null> {
    const [rows] = await this.pool.execute<IdentityRow[]>(
      `SELECT u.id AS user_id, s.id AS session_id, u.email, u.token_version, u.status, u.email_verified_at
       FROM users u JOIN auth_sessions s ON s.user_id = u.id
       WHERE u.id = ? AND s.id = ? AND u.status = 'active' AND u.email_verified_at IS NOT NULL
         AND s.revoked_at IS NULL AND s.rotated_at IS NULL
         AND s.expires_at > CURRENT_TIMESTAMP(6) AND s.absolute_expires_at > CURRENT_TIMESTAMP(6)
       LIMIT 1`,
      [userId, sessionId],
    )
    const row = rows[0]
    return row
      ? { userId: row.user_id, sessionId: row.session_id, email: row.email, tokenVersion: row.token_version }
      : null
  }

  async revokeSession(userId: string, sessionId: string, reason: string): Promise<boolean> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP(6), revocation_reason = ?
       WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
      [reason, sessionId, userId],
    )
    return result.affectedRows > 0
  }

  async revokeAllSessions(userId: string, reason: string): Promise<void> {
    await this.pool.execute(
      `UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP(6), revocation_reason = ?
       WHERE user_id = ? AND revoked_at IS NULL`,
      [reason, userId],
    )
  }

  async changePassword(userId: string, passwordHash: string): Promise<void> {
    await withTransaction(
      this.pool,
      async (connection) => {
        await connection.execute(
          `UPDATE user_credentials SET password_hash = ?, hash_version = hash_version + 1,
           password_changed_at = CURRENT_TIMESTAMP(6) WHERE user_id = ?`,
          [passwordHash, userId],
        )
        await connection.execute('UPDATE users SET token_version = token_version + 1 WHERE id = ?', [userId])
        await connection.execute(
          `UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP(6), revocation_reason = 'password_changed'
           WHERE user_id = ? AND revoked_at IS NULL`,
          [userId],
        )
      },
      this.acquisitionTimeoutMs,
    )
  }

  async listSessions(userId: string, currentSessionId: string): Promise<SessionView[]> {
    const [rows] = await this.pool.execute<(RowDataPacket & Omit<SessionView, 'current'>)[]>(
      `SELECT id, user_agent AS userAgent, created_at AS createdAt, last_used_at AS lastUsedAt, expires_at AS expiresAt
       FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL AND rotated_at IS NULL
       AND expires_at > CURRENT_TIMESTAMP(6) ORDER BY created_at DESC LIMIT 100`,
      [userId],
    )
    return rows.map((row) => ({ ...row, current: row.id === currentSessionId }))
  }

  async securityEvent(
    eventType: string,
    outcome: string,
    context: RequestContext,
    userId?: string,
    sessionId?: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.pool.execute(
      `INSERT INTO security_events (user_id, session_id, event_type, outcome, ip_hash, request_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        userId ?? null,
        sessionId ?? null,
        eventType,
        outcome,
        context.ipHash,
        context.requestId,
        JSON.stringify(metadata ?? {}),
      ],
    )
  }
}

function mapAuthUser(row: AuthUserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    status: row.status,
    emailVerifiedAt: row.email_verified_at,
    tokenVersion: row.token_version,
    failedLoginCount: row.failed_login_count,
    lockedUntil: row.locked_until,
    passwordHash: row.password_hash,
  }
}

function challengeUsable(challenge: ChallengeRow): boolean {
  return (
    !challenge.consumed_at &&
    challenge.attempts < challenge.max_attempts &&
    Date.parse(challenge.expires_at) > Date.now()
  )
}

function isDuplicateEntry(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ER_DUP_ENTRY')
}

export function newUuid(): string {
  return randomUUID()
}
