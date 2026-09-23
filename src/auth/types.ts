export type UserStatus = 'pending_verification' | 'active' | 'locked' | 'deleted'
export type ChallengePurpose = 'verify_email' | 'reset_password'

export type AuthUser = {
  id: string
  email: string
  status: UserStatus
  emailVerifiedAt: string | null
  tokenVersion: number
  failedLoginCount: number
  lockedUntil: string | null
  passwordHash: string
}

export type AuthIdentity = {
  userId: string
  sessionId: string
  email: string
  tokenVersion: number
}

export type SessionTokens = {
  accessToken: string
  accessTokenExpiresIn: number
  refreshToken: string
  csrfToken: string
  sessionId: string
}

export type RequestContext = {
  requestId: string
  ipHash: string | null
  userAgent: string | null
}

export type SessionView = {
  id: string
  userAgent: string | null
  createdAt: string
  lastUsedAt: string
  expiresAt: string
  current: boolean
}
