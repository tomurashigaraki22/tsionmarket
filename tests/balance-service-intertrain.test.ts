import { describe, expect, it, vi } from 'vitest'
import type { Environment } from '../src/config/env.js'
import { AppError } from '../src/utils/errors.js'
import { BalanceService } from '../src/portfolio/BalanceService.js'
import type { Account, PortfolioRepository } from '../src/portfolio/PortfolioRepository.js'
import type { RpcManager } from '../src/portfolio/RpcManager.js'

const intertrainAccount: Account = {
  id: 'intertrain-account',
  networkId: 'intertrain-mainnet',
  address: 'mna1q8lye5pxhet776htmfrgf2ffrvztuf0j65dyuyjz',
  family: 'intertrain',
  ownershipStatus: 'verified',
}
const arbitrumAccount: Account = {
  id: 'arbitrum-account',
  networkId: 'arbitrum-one',
  address: '0x0000000000000000000000000000000000000001',
  family: 'evm',
  ownershipStatus: 'verified',
}
const chainInfo = {
  chain_id: 'intertrain-1',
  native_asset: { symbol: 'WSK', decimals: 6 },
}
const env = {
  BALANCE_CACHE_TTL_MS: 1_000,
  BALANCE_MAX_CONCURRENCY: 2,
  BALANCE_AGGREGATE_TIMEOUT_MS: 500,
} as Environment

function serviceHarness(accounts: Account[], intertrainFailure = false) {
  const repo = {
    listAccounts: vi.fn(async () => accounts),
    marketTokens: vi.fn(async () => []),
  } as unknown as PortfolioRepository
  const rpc = {
    intertrainRequest: vi.fn(async (_network: unknown, method: string) => {
      if (intertrainFailure)
        throw new AppError('RPC_ALL_PROVIDERS_FAILED', 'Intertrain RPC is unavailable', 503)
      if (method === 'chain_info') return chainInfo
      return {
        address: intertrainAccount.address,
        balance: '1250000',
        nonce: 0,
        assets: {},
      }
    }),
    evmClient: vi.fn(() => ({
      getBalance: async () => 2_000_000_000_000_000_000n,
      readContract: async () => 0n,
    })),
  } as unknown as RpcManager
  return new BalanceService(repo, rpc, env)
}

describe('Intertrain balance aggregation', () => {
  it('returns native WSK with six decimals alongside existing EVM balances', async () => {
    const service = serviceHarness([arbitrumAccount, intertrainAccount])
    const snapshot = await service.portfolio('user')
    const intertrain = snapshot.accounts.find((account) => account.networkId === 'intertrain-mainnet')
    const arbitrum = snapshot.accounts.find((account) => account.networkId === 'arbitrum-one')

    expect(intertrain).toMatchObject({
      state: 'ready',
      assets: [
        {
          assetId: 'native',
          symbol: 'WSK',
          decimals: 6,
          raw: '1250000',
          formatted: '1.25',
        },
      ],
    })
    expect(arbitrum?.state).toBe('ready')
    expect(snapshot.errors).toBe(0)
  })

  it('keeps Arbitrum balances available when the Intertrain RPC fails', async () => {
    const service = serviceHarness([arbitrumAccount, intertrainAccount], true)
    const snapshot = await service.portfolio('user')

    expect(snapshot.accounts.find((account) => account.networkId === 'arbitrum-one')?.state).toBe('ready')
    expect(snapshot.accounts.find((account) => account.networkId === 'intertrain-mainnet')).toMatchObject({
      state: 'unavailable',
      error: { code: 'RPC_ALL_PROVIDERS_FAILED' },
    })
    expect(snapshot.errors).toBe(1)
  })
})
