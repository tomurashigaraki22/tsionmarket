import { Router } from 'express'
import { z } from 'zod'
import { requireIdentity } from '../../auth/middleware.js'
import type { QuoteService } from '../../trading/QuoteService.js'
import type { IntentService } from '../../trading/IntentService.js'
import { asyncHandler } from '../../utils/asyncHandler.js'
import rateLimit from 'express-rate-limit'
import type { TransactionRepository } from '../../transactions/TransactionRepository.js'
import { AppError } from '../../utils/errors.js'
import type { WithdrawalIntentService } from '../../trading/WithdrawalIntentService.js'

export const quoteInputSchema = z
  .object({
    marketId: z.string().min(1).max(320),
    side: z.enum(['buy', 'sell']),
    amountRaw: z
      .string()
      .regex(/^[1-9]\d*$/)
      .max(65),
    sourceAccountId: z.string().uuid(),
    sourcePaymentId: z.string().uuid().optional(),
    slippageBps: z.number().int().min(1).max(5000).default(50),
  })
  .strict()
export const intentInputSchema = z
  .object({ quoteId: z.string().uuid(), idempotencyKey: z.string().min(8).max(200) })
  .strict()
export const withdrawalIntentInputSchema = z
  .object({
    accountId: z.string().uuid(),
    assetId: z.string().min(1).max(128),
    toAddress: z.string().trim().min(1).max(128),
    amountRaw: z.string().regex(/^[1-9]\d{0,77}$/),
    idempotencyKey: z.string().min(8).max(200),
    publicKey: z
      .string()
      .regex(/^(?:0x)?(?:[0-9a-f]{2}){32}$/i)
      .optional(),
  })
  .strict()
export function tradingRouter(
  quotes: QuoteService,
  intents: IntentService,
  controls: TransactionRepository,
  withdrawals?: WithdrawalIntentService,
) {
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
        data: await quotes.create(requireIdentity(req).userId, quoteInputSchema.parse(req.body)),
      })
    }),
  )
  router.post(
    '/transaction-intents',
    intentLimit,
    asyncHandler(async (req, res) => {
      if (await controls.control('intent_creation_paused'))
        throw new AppError('EXECUTION_PAUSED', 'Intent creation is paused', 503)
      const result = await intents.create(requireIdentity(req).userId, intentInputSchema.parse(req.body))
      res.status(result.existing ? 200 : 201).json({ success: true, data: result })
    }),
  )
  if (withdrawals) {
    router.post(
      '/wallets/me/withdrawal-intents',
      intentLimit,
      asyncHandler(async (req, res) => {
        if (await controls.control('intent_creation_paused'))
          throw new AppError('EXECUTION_PAUSED', 'Transaction intent creation is paused', 503)
        const result = await withdrawals.create(
          requireIdentity(req).userId,
          withdrawalIntentInputSchema.parse(req.body),
        )
        res.status(result.existing ? 200 : 201).json({ success: true, data: result })
      }),
    )
  }
  return router
}
