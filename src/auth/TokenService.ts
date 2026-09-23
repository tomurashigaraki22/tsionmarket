import { jwtVerify, SignJWT, type JWTPayload } from 'jose'
import type { Environment } from '../config/env.js'
import { AppError } from '../utils/errors.js'

type AccessClaims = JWTPayload & { sid: string; ver: number }

export class TokenService {
  private readonly encoder = new TextEncoder()

  constructor(private readonly environment: Environment) {}

  async signAccessToken(input: { userId: string; sessionId: string; tokenVersion: number }): Promise<string> {
    return new SignJWT({ sid: input.sessionId, ver: input.tokenVersion })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT', kid: this.environment.AUTH_ACCESS_TOKEN_KID })
      .setSubject(input.userId)
      .setIssuer(this.environment.AUTH_TOKEN_ISSUER)
      .setAudience(this.environment.AUTH_TOKEN_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${this.environment.AUTH_ACCESS_TOKEN_TTL_SECONDS}s`)
      .sign(this.encoder.encode(this.environment.AUTH_ACCESS_TOKEN_SECRET))
  }

  async verifyAccessToken(
    token: string,
  ): Promise<{ userId: string; sessionId: string; tokenVersion: number }> {
    try {
      const { payload } = await jwtVerify(
        token,
        (header) => {
          if (header.alg !== 'HS256') throw new Error('Unexpected access-token algorithm')
          if (header.kid === this.environment.AUTH_ACCESS_TOKEN_KID) {
            return this.encoder.encode(this.environment.AUTH_ACCESS_TOKEN_SECRET)
          }
          if (
            this.environment.AUTH_ACCESS_TOKEN_PREVIOUS_SECRET &&
            this.environment.AUTH_ACCESS_TOKEN_PREVIOUS_KID &&
            header.kid === this.environment.AUTH_ACCESS_TOKEN_PREVIOUS_KID
          ) {
            return this.encoder.encode(this.environment.AUTH_ACCESS_TOKEN_PREVIOUS_SECRET)
          }
          throw new Error('Unknown access-token key')
        },
        {
          algorithms: ['HS256'],
          issuer: this.environment.AUTH_TOKEN_ISSUER,
          audience: this.environment.AUTH_TOKEN_AUDIENCE,
        },
      )
      const claims = payload as AccessClaims
      if (!claims.sub || !claims.sid || !Number.isInteger(claims.ver)) {
        throw new Error('Incomplete access-token claims')
      }
      return { userId: claims.sub, sessionId: claims.sid, tokenVersion: claims.ver }
    } catch {
      throw new AppError('AUTH_REQUIRED', 'Authentication required', 401)
    }
  }
}
