import { Router } from 'express'
import { z } from 'zod'
import { requireIdentity } from '../../auth/middleware.js'
import type { QuoteService } from '../../trading/QuoteService.js'
import type { IntentService } from '../../trading/IntentService.js'
import { asyncHandler } from '../../utils/asyncHandler.js'
import rateLimit from 'express-rate-limit'
import type { TransactionRepository } from '../../transactions/TransactionRepository.js'
import { AppError } from '../../utils/errors.js'

const quote = z.object({
  marketId: z.string().min(1).max(320),
  side: z.enum(['buy', 'sell']),
  amountRaw: z
    .string()
    .regex(/^[1-9]\d*$/)
    .max(65),
  sourceAccountId: z.string().uuid(),
  slippageBps: z.number().int().min(1).max(5000).default(50),
})
const intent = z.object({ quoteId: z.string().uuid(), idempotencyKey: z.string().min(8).max(200) })
export function tradingRouter(quotes: QuoteService, intents: IntentService, controls: TransactionRepository) {
  const router = Router()
  const quoteLimit = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  })
  const intentLimit = rateLimit({
    windowMs: 60_000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  })
  router.post(
    '/quotes',
    quoteLimit,
    asyncHandler(async (req, res) => {
      if (await controls.control('quotes_paused'))
        throw new AppError('EXECUTION_PAUSED', 'Executable quotes are paused', 503)
      res.status(201).json({
        success: true,
        data: await quotes.create(requireIdentity(req).userId, quote.parse(req.body)),
      })
    }),
  )
  router.post(
    '/transaction-intents',
    intentLimit,
    asyncHandler(async (req, res) => {
      if (await controls.control('intent_creation_paused'))
        throw new AppError('EXECUTION_PAUSED', 'Intent creation is paused', 503)
      const result = await intents.create(requireIdentity(req).userId, intent.parse(req.body))
      res.status(result.existing ? 200 : 201).json({ success: true, data: result })
    }),
  )
  return router
}
