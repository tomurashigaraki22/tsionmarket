import { describe, expect, it, vi } from 'vitest'
import { BalanceService } from '../src/portfolio/BalanceService.js'
import type { PortfolioRepository } from '../src/portfolio/PortfolioRepository.js'
import type { RpcManager } from '../src/portfolio/RpcManager.js'
import type { Environment } from '../src/config/env.js'

describe('selected asset balance', () => {
  it('reads the owned account and the token used by a market', async () => {
    const getBalance = vi.fn(async () => 2500000000000000000n)
    const repo = {
      listAccounts: async () => [
        {
          id: 'owned',
          networkId: 'ethereum-mainnet',
          address: '0x0000000000000000000000000000000000000001',
          family: 'evm',
          ownershipStatus: 'verified',
        },
      ],
      marketTokens: async () => [
        { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', decimals: 18 },
      ],
    } as unknown as PortfolioRepository
    const rpc = { evmClient: () => ({ getBalance }) } as unknown as RpcManager
    const service = new BalanceService(repo, rpc, {} as Environment)
    const balance = await service.assetBalance('user', 'owned', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2')
    expect(balance.raw).toBe('2500000000000000000')
    expect(balance.formatted).toBe('2.5')
    expect(balance.symbol).toBe('ETH')
    expect(getBalance).toHaveBeenCalledOnce()
    await expect(
      service.assetBalance('user', 'another-account', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'),
    ).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' })
  })
})
