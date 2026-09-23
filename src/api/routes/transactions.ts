import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { requireIdentity } from '../../auth/middleware.js'
import type { TransactionRepository } from '../../transactions/TransactionRepository.js'
import type { TransactionService } from '../../transactions/TransactionService.js'
import { asyncHandler } from '../../utils/asyncHandler.js'
import { AppError } from '../../utils/errors.js'

const submission = z.object({ signedTransaction: z.string().min(20) }).strict(),
  history = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().max(1000).optional(),
  })
export function transactionsRouter(service: TransactionService, repo: TransactionRepository) {
  const router = Router(),
    submitLimit = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false })
  router.post(
    '/transaction-intents/:intentId/submit',
    submitLimit,
    asyncHandler(async (req, res) => {
      const body = submission.parse(req.body),
        result = await service.submit(
          requireIdentity(req).userId,
          z.string().uuid().parse(req.params.intentId),
          body.signedTransaction,
          req.requestId,
        )
      res.status(result.existing ? 200 : 202).json({ success: true, data: result })
    }),
  )
  router.get(
    '/transactions',
    asyncHandler(async (req, res) =>
      res.json({
        success: true,
        data: await repo.history(
          requireIdentity(req).userId,
          history.parse(req.query).limit,
          history.parse(req.query).cursor,
        ),
      }),
    ),
  )
  router.get(
    '/transactions/:transactionId',
    asyncHandler(async (req, res) => {
      const record = await repo.get(
        requireIdentity(req).userId,
        z.string().uuid().parse(req.params.transactionId),
      )
      if (!record) throw new AppError('TRANSACTION_NOT_FOUND', 'Transaction not found', 404)
      res.json({ success: true, data: record })
    }),
  )
  return router
}
