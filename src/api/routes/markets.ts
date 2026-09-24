import { Router } from 'express'
import { z } from 'zod'
import { asyncHandler } from '../../utils/asyncHandler.js'
import type { MarketRepository } from '../../markets/MarketRepository.js'
import type { ChartService } from '../../markets/ChartService.js'
import { INTERVAL_SECONDS } from '../../markets/chartData.js'

export const chartQuerySchema = z
  .object({
    networkId: z.string().min(1).max(64),
    token: z.string().min(1).max(128),
    interval: z.enum(Object.keys(INTERVAL_SECONDS) as [string, ...Array<string>]).default('1h'),
    // The registry's chart_symbol — a CoinGecko coin id, where it has one.
    coinId: z.string().max(128).optional(),
    before: z.coerce.number().int().positive().optional(),
    source: z.enum(['birdeye', 'geckoterminal', 'coingecko']).optional(),
  })
  .strict()
export const marketQuerySchema = z
  .object({
    networkId: z.string().max(64).optional(),
    venue: z.enum(['0x', 'jupiter']).optional(),
    search: z.string().max(64).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().max(1000).optional(),
  })
  .strict()
export function marketsRouter(repo: MarketRepository, staleAfter: number, charts: ChartService) {
  const router = Router()
  // Registered before '/markets' matters only for readability here, but the
  // chart path must not be shadowed by a future '/markets/:id'.
  router.get(
    '/markets/chart',
    asyncHandler(async (req, res) => {
      const query = chartQuerySchema.parse(req.query)
      res.json({
        success: true,
        data: await charts.candles({
          networkId: query.networkId,
          token: query.token,
          interval: query.interval,
          coinId: query.coinId,
          before: query.before,
          source: query.source,
        }),
      })
    }),
  )
  router.get(
    '/markets',
    asyncHandler(async (req, res) =>
      res.json({ success: true, data: await repo.browse(marketQuerySchema.parse(req.query), staleAfter) }),
    ),
  )
  return router
}
