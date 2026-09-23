import { Router } from 'express'
import { isAddress } from 'viem'
import { PublicKey } from '@solana/web3.js'
import { z } from 'zod'
import { asyncHandler } from '../../utils/asyncHandler.js'
import { AppError } from '../../utils/errors.js'
import { requireIdentity } from '../../auth/middleware.js'
import type { PortfolioRepository } from '../../portfolio/PortfolioRepository.js'
import type { BalanceService } from '../../portfolio/BalanceService.js'
import { NETWORKS } from '../../portfolio/networks.js'

const account = z.object({
  networkId: z.string().max(64),
  address: z.string().max(128),
  label: z.string().max(100).optional(),
})
export function portfolioRouter(repo: PortfolioRepository, balances: BalanceService) {
  const router = Router()
  router.get(
    '/networks',
    asyncHandler(async (_req, res) => res.json({ success: true, data: await repo.listNetworks() })),
  )
  router.get(
    '/wallets/me/accounts',
    asyncHandler(async (req, res) =>
      res.json({ success: true, data: await repo.listAccounts(requireIdentity(req).userId) }),
    ),
  )
  router.post(
    '/wallets/me/accounts',
    asyncHandler(async (req, res) => {
      const input = account.parse(req.body),
        network = NETWORKS.find((n) => n.networkId === input.networkId)
      if (!network) throw new AppError('NETWORK_UNSUPPORTED', 'Network is not supported', 400)
      try {
        if (network.family === 'evm' && !isAddress(input.address)) throw new Error()
        if (network.family === 'solana') new PublicKey(input.address)
      } catch {
        throw new AppError('INVALID_ADDRESS', 'Address is invalid for this network', 400)
      }
      const id = await repo.addAccount(
        requireIdentity(req).userId,
        input.networkId,
        input.address,
        input.label,
      )
      res.status(201).json({ success: true, data: { id } })
    }),
  )
  router.get(
    '/wallets/me/balances',
    asyncHandler(async (req, res) =>
      res.json({
        success: true,
        data: await balances.portfolio(requireIdentity(req).userId, req.query.refresh === 'true'),
      }),
    ),
  )
  return router
}
