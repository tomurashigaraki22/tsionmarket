import { Router } from 'express'
import { z } from 'zod'
import { asyncHandler } from '../../utils/asyncHandler.js'
import type { MarketRepository } from '../../markets/MarketRepository.js'
const query = z.object({
  networkId: z.string().max(64).optional(),
  venue: z.enum(['0x', 'jupiter']).optional(),
  search: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(1000).optional(),
})
export function marketsRouter(repo: MarketRepository, staleAfter: number) {
  const router = Router()
  router.get(
    '/markets',
    asyncHandler(async (req, res) =>
      res.json({ success: true, data: await repo.browse(query.parse(req.query), staleAfter) }),
    ),
  )
  return router
}
