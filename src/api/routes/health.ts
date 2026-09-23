import { Router } from 'express'
import { asyncHandler } from '../../utils/asyncHandler.js'
import type { ReadinessCheck } from '../../services/readiness.js'

export function healthRouter(readinessCheck: ReadinessCheck): Router {
  const router = Router()

  router.get('/health', (_request, response) => {
    response.json({
      success: true,
      data: { status: 'ok', service: 'tsionmarket-backend', timestamp: new Date().toISOString() },
    })
  })

  router.get(
    '/ready',
    asyncHandler(async (request, response) => {
      const result = await readinessCheck()
      response.status(result.ready ? 200 : 503).json({
        success: result.ready,
        ...(result.ready
          ? { data: { status: 'ready', checks: result.checks } }
          : {
              error: { code: 'SERVICE_NOT_READY', message: result.reason ?? 'Service is not ready' },
              data: { status: 'not_ready', checks: result.checks },
              requestId: request.requestId,
            }),
      })
    }),
  )

  return router
}
