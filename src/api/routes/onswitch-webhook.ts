import express, { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { asyncHandler } from '../../utils/asyncHandler.js'
import { AppError } from '../../utils/errors.js'
import type { OnSwitchWebhookService } from '../../payments/onswitch/webhook.js'

export function onSwitchWebhookRouter(service: OnSwitchWebhookService) {
  const router = Router()
  const limit = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  })
  router.post(
    '/v1/providers/onswitch/webhook',
    express.raw({ type: ['application/json', 'application/*+json'], limit: '128kb' }),
    limit,
    (request, _response, next) => {
      if (!Buffer.isBuffer(request.body)) {
        next(new AppError('WEBHOOK_INVALID_BODY', 'Webhook body is invalid', 400))
        return
      }
      next()
    },
    asyncHandler(async (request, response) => {
      const result = await service.receive(
        request.body as Buffer,
        request.header('x-switch-signature'),
        request.header('x-switch-timestamp'),
      )
      response.status(result.duplicate ? 200 : 202).json({ success: true, data: result })
    }),
  )
  return router
}
