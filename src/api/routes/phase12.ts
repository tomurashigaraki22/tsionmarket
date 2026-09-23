import { Router } from 'express'
import { z } from 'zod'
import { requireIdentity } from '../../auth/middleware.js'
import { chainAdapters, sponsorshipProviders } from '../../extensions/registries.js'
import type { ValuationService } from '../../portfolio/ValuationService.js'
import type { TransactionRepository } from '../../transactions/TransactionRepository.js'
import { asyncHandler } from '../../utils/asyncHandler.js'

export const valuationHistoryQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(100).default(30) })
  .strict()

export function phase12Router(valuations: ValuationService, transactions: TransactionRepository) {
  const router = Router()
  router.get(
    '/portfolio/valuation',
    asyncHandler(async (req, res) =>
      res.json({ success: true, data: await valuations.current(requireIdentity(req).userId) }),
    ),
  )
  router.get(
    '/portfolio/valuation/history',
    asyncHandler(async (req, res) =>
      res.json({
        success: true,
        data: await valuations.history(
          requireIdentity(req).userId,
          valuationHistoryQuerySchema.parse(req.query).limit,
        ),
      }),
    ),
  )
  router.get(
    '/capabilities',
    asyncHandler(async (_req, res) =>
      res.json({
        success: true,
        data: {
          chainAdapters: chainAdapters.list(),
          sponsorship: sponsorshipProviders.config(),
          advancedOrders: {
            enabled: false,
            reason:
              'No provider with defined cancellation, partial-fill, and settlement semantics is configured',
          },
          transactionStream: { transport: 'sse', path: '/v1/transactions/stream' },
          execution: {
            quotesPaused: await transactions.control('quotes_paused'),
            intentCreationPaused: await transactions.control('intent_creation_paused'),
          },
        },
      }),
    ),
  )
  // '/transactions/stream' is served by transactionsRouter, which app.ts
  // mounts first. A second handler for the same path lived here and was
  // unreachable; it is not re-added, so mount order cannot silently change
  // which implementation answers.
  return router
}
