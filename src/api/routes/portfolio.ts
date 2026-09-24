import { Router } from 'express'
import { z } from 'zod'
import rateLimit from 'express-rate-limit'
import { asyncHandler } from '../../utils/asyncHandler.js'
import { requireIdentity } from '../../auth/middleware.js'
import type { PortfolioRepository } from '../../portfolio/PortfolioRepository.js'
import type { BalanceService } from '../../portfolio/BalanceService.js'
import type { OwnershipService } from '../../portfolio/OwnershipService.js'
import { intertrainUsdcBridgeStatus } from '../../portfolio/intertrainBridgeStatus.js'

export const ownershipChallengeInputSchema = z
  .object({
    networkId: z.string().min(1).max(64),
    address: z.string().min(1).max(128),
  })
  .strict()
export const ownershipProofInputSchema = z
  .object({
    challengeId: z.string().uuid(),
    networkId: z.string().min(1).max(64),
    address: z.string().min(1).max(128),
    signature: z.string().min(20).max(1024),
    publicKey: z.string().min(20).max(256).optional(),
    label: z.string().max(100).optional(),
    idempotencyKey: z.string().min(8).max(200),
  })
  .strict()

export const balancesQuerySchema = z.object({ refresh: z.enum(['true', 'false']).default('false') }).strict()
export const assetBalanceQuerySchema = z
  .object({
    accountId: z.string().uuid(),
    token: z.string().min(1).max(128),
  })
  .strict()
export function portfolioRouter(
  repo: PortfolioRepository,
  balances: BalanceService,
  ownership: OwnershipService,
) {
  const router = Router()
  const proofLimit = rateLimit({
    windowMs: 15 * 60_000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  })
  router.get(
    '/networks',
    asyncHandler(async (_req, res) => res.json({ success: true, data: await repo.listNetworks() })),
  )
  router.get(
    '/bridge/intertrain/usdc/status',
    (_req, res) => res.json({ success: true, data: intertrainUsdcBridgeStatus() }),
  )
  router.get(
    '/wallets/me/accounts',
    asyncHandler(async (req, res) =>
      res.json({ success: true, data: await repo.listAccounts(requireIdentity(req).userId) }),
    ),
  )
  router.post(
    '/wallets/me/accounts/challenge',
    proofLimit,
    asyncHandler(async (req, res) => {
      const input = ownershipChallengeInputSchema.parse(req.body)
      res.status(201).json({
        success: true,
        data: await ownership.challenge(requireIdentity(req).userId, input.networkId, input.address),
      })
    }),
  )
  router.post(
    '/wallets/me/accounts',
    proofLimit,
    asyncHandler(async (req, res) => {
      const result = await ownership.register(
        requireIdentity(req).userId,
        ownershipProofInputSchema.parse(req.body),
      )
      res.status(result.existing ? 200 : 201).json({ success: true, data: result })
    }),
  )
  router.get(
    '/wallets/me/balances/asset',
    asyncHandler(async (req, res) => {
      const query = assetBalanceQuerySchema.parse(req.query)
      res.json({
        success: true,
        data: await balances.assetBalance(requireIdentity(req).userId, query.accountId, query.token),
      })
    }),
  )
  router.get(
    '/wallets/me/balances',
    asyncHandler(async (req, res) =>
      res.json({
        success: true,
        data: await balances.portfolio(
          requireIdentity(req).userId,
          balancesQuerySchema.parse(req.query).refresh === 'true',
        ),
      }),
    ),
  )
  return router
}
