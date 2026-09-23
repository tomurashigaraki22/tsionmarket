import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { requireIdentity } from '../../auth/middleware.js'
import type { TransactionRepository } from '../../transactions/TransactionRepository.js'
import type { TransactionService } from '../../transactions/TransactionService.js'
import { asyncHandler } from '../../utils/asyncHandler.js'
import { AppError } from '../../utils/errors.js'

export const transactionSubmissionSchema = z.object({ signedTransaction: z.string().min(20) }).strict()
export const transactionHistoryQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().max(1000).optional(),
  })
  .strict()
export const transactionStreamQuerySchema = z.object({ since: z.string().datetime().optional() }).strict()

// Polling interval for the SSE loop below. changesSince() is a cheap indexed
// query (user_id, updated_at), so per-connection polling is fine at this
// cadence and needs no message bus. If the API ever runs more than one
// instance this stays correct — every instance polls the same database row
// set — it just adds up to N redundant polls per connected user.
const STREAM_POLL_MS = 2_000
const STREAM_HEARTBEAT_MS = 15_000

export function transactionsRouter(service: TransactionService, repo: TransactionRepository) {
  const router = Router(),
    submitLimit = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false })
  router.post(
    '/transaction-intents/:intentId/submit',
    submitLimit,
    asyncHandler(async (req, res) => {
      const body = transactionSubmissionSchema.parse(req.body),
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
    asyncHandler(async (req, res) => {
      const query = transactionHistoryQuerySchema.parse(req.query)
      res.json({
        success: true,
        data: await repo.history(requireIdentity(req).userId, query.limit, query.cursor),
      })
    }),
  )
  // Registered before '/transactions/:transactionId'. Express matches in
  // registration order, so the parameterised route would otherwise capture
  // this path and reject 'stream' as a malformed transaction UUID.
  //
  // Authenticated the same way as every other /v1 route: the Authorization
  // Bearer header, via the authenticationMiddleware this router is mounted
  // behind. Native EventSource cannot send that header, so the frontend must
  // use a fetch-based SSE client rather than `new EventSource(...)` — see
  // src/lib/api/stream.ts. This was chosen over a short-lived stream-ticket
  // endpoint because it introduces no new credential type or issuance/replay
  // surface, and over loosening cookie SameSite policy because that would
  // weaken CSRF protection for every route to support one endpoint.
  router.get(
    '/transactions/stream',
    asyncHandler(async (req, res) => {
      const userId = requireIdentity(req).userId
      const query = transactionStreamQuerySchema.parse(req.query)
      let cursor = query.since ? new Date(query.since) : new Date()

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.write(`retry: 3000\n\n`)

      let closed = false
      req.on('close', () => {
        closed = true
      })

      const heartbeat = setInterval(() => {
        if (!closed) res.write(`:hb\n\n`)
      }, STREAM_HEARTBEAT_MS)

      try {
        while (!closed) {
          const changes = await repo.changesSince(userId, cursor)
          for (const change of changes as Array<{ updatedAt: string | Date }>) {
            res.write(`id: ${new Date(change.updatedAt).toISOString()}\n`)
            res.write(`event: transaction\n`)
            res.write(`data: ${JSON.stringify(change)}\n\n`)
          }
          if (changes.length > 0) {
            const last = changes[changes.length - 1] as { updatedAt: string | Date }
            cursor = new Date(last.updatedAt)
          }
          await new Promise((resolve) => setTimeout(resolve, STREAM_POLL_MS))
        }
      } finally {
        clearInterval(heartbeat)
        res.end()
      }
    }),
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
