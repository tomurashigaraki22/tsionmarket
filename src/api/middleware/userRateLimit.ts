import rateLimit from 'express-rate-limit'
import { increment } from '../../observability/metrics.js'

type UserRateLimitAudit = (event: {
  userId: string
  requestId?: string
  category: string
  route: string
}) => Promise<void>

/**
 * Adds an authenticated-user bucket alongside the route's existing IP bucket.
 * The global /v1 authentication middleware must run before this middleware.
 * The in-memory store is process-local; deployments with multiple API replicas
 * should replace it with a shared rate-limit store before increasing replicas.
 */
export function userRateLimit(options: { windowMs: number; limit: number }, audit?: UserRateLimitAudit) {
  return rateLimit({
    ...options,
    keyGenerator: (request) => {
      const userId = request.identity?.userId
      return userId ? `user:${userId}` : `unauthenticated:${request.ip}`
    },
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: async (request, response) => {
      increment('onswitch_user_rate_limited_total')
      const userId = request.identity?.userId
      if (audit && userId) {
        try {
          const routePattern = (request as unknown as { route?: { path?: unknown } }).route?.path
          await audit({
            userId,
            ...(request.requestId ? { requestId: request.requestId } : {}),
            category: 'route_rate_limit',
            route: typeof routePattern === 'string' ? routePattern : 'unmatched',
          })
        } catch {
          increment('onswitch_security_audit_write_failures_total')
        }
      }
      response.status(429).json({
        success: false,
        error: { code: 'RATE_LIMITED', message: 'Too many payment requests' },
        requestId: request.requestId,
      })
    },
  })
}
