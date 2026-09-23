/* eslint-disable @typescript-eslint/no-unsafe-argument -- direct SQL SSE rows are normalized at the stream boundary */
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
  router.get('/transactions/stream', (req, res) => {
    const userId = requireIdentity(req).userId
    res.status(200).set({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.flushHeaders()
    let cursor = new Date(),
      closed = false
    const send = async () => {
      if (closed) return
      const rows = await transactions.changesSince(userId, cursor)
      for (const row of rows) {
        const updated = new Date(row.updatedAt)
        if (updated > cursor) cursor = updated
        res.write(`id: ${String(row.id)}\nevent: transaction\ndata: ${JSON.stringify(row)}\n\n`)
      }
      res.write(`: heartbeat ${Date.now()}\n\n`)
    }
    const timer = setInterval(
      () => void send().catch(() => res.write(`event: unavailable\ndata: {"retry":true}\n\n`)),
      5000,
    )
    timer.unref()
    const maximum = setTimeout(() => res.end(), 5 * 60_000)
    maximum.unref()
    req.on('close', () => {
      closed = true
      clearInterval(timer)
      clearTimeout(maximum)
    })
    res.write(`event: ready\ndata: {"connected":true}\n\n`)
  })
  return router
}
