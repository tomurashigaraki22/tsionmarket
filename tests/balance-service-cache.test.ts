import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Environment } from '../src/config/env.js'
import { BalanceService } from '../src/portfolio/BalanceService.js'
import { NETWORKS, BALANCE_TOKENS } from '../src/portfolio/networks.js'
import type { Account, PortfolioRepository } from '../src/portfolio/PortfolioRepository.js'
import { RpcManager } from '../src/portfolio/RpcManager.js'

const address = '0x0000000000000000000000000000000000000001'
const account = (id: string, networkId = 'arbitrum-one'): Account => ({
  id,
  networkId,
  address,
  family: 'evm',
  ownershipStatus: 'verified',
})
const tokens = BALANCE_TOKENS['arbitrum-one']!
const env = {
  BALANCE_CACHE_TTL_MS: 45_000,
  BALANCE_STALE_TTL_MS: 300_000,
  BALANCE_MAX_CONCURRENCY: 2,
  BALANCE_AGGREGATE_TIMEOUT_MS: 500,
} as Environment

function harness(accounts: Record<string, Account[]>) {
  const repo = {
    listAccounts: vi.fn(async (userId: string) => accounts[userId] ?? []),
    marketTokens: vi.fn(async () => []),
  } as unknown as PortfolioRepository
  const multicall = vi.fn(async () => [3n * 10n ** 18n, 5_000_000n, 2n * 10n ** 18n])
  const getBalance = vi.fn(async () => 1n)
  const readContract = vi.fn(async () => 0n)
  const rpc = {
    evmClient: vi.fn(() => ({ multicall, getBalance, readContract })),
  } as unknown as RpcManager
  return { service: new BalanceService(repo, rpc, env), multicall, getBalance, readContract }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-07T00:00:00Z'))
})
afterEach(() => vi.useRealTimers())

describe('EVM balances', () => {
  it('reads the native balance and every token in one call', async () => {
    const { service, multicall, getBalance, readContract } = harness({ u: [account('a')] })
    const snapshot = await service.portfolio('u')

    expect(multicall).toHaveBeenCalledOnce()
    expect(getBalance).not.toHaveBeenCalled()
    expect(readContract).not.toHaveBeenCalled()
    const assets = snapshot.accounts[0]!.assets
    expect(assets).toHaveLength(tokens.length + 1)
    expect(assets[0]).toMatchObject({ assetId: 'native', symbol: 'ETH', formatted: '3' })
    expect(assets[1]).toMatchObject({ symbol: 'USDC', formatted: '5' })
    expect(assets[2]).toMatchObject({ symbol: 'WETH', formatted: '2' })
  })

  it('falls back to individual reads when multicall is unavailable', async () => {
    const { service, multicall, getBalance, readContract } = harness({ u: [account('a')] })
    multicall.mockRejectedValue(new Error('multicall3 not deployed'))
    const snapshot = await service.portfolio('u')

    expect(snapshot.accounts[0]!.state).toBe('ready')
    expect(getBalance).toHaveBeenCalledOnce()
    expect(readContract).toHaveBeenCalledTimes(tokens.length)
  })
})

describe('balance cache', () => {
  it('serves a repeat read from cache within the TTL', async () => {
    const { service, multicall } = harness({ u: [account('a')] })
    await service.portfolio('u')
    await service.portfolio('u')
    expect(multicall).toHaveBeenCalledOnce()
  })

  it('shares one read between users who hold the same address, each with their own account id', async () => {
    const { service, multicall } = harness({ one: [account('a1')], two: [account('a2')] })
    const [first, second] = await Promise.all([service.portfolio('one'), service.portfolio('two')])
    expect(multicall).toHaveBeenCalledOnce()
    expect(first.accounts[0]!.accountId).toBe('a1')
    expect(second.accounts[0]!.accountId).toBe('a2')
  })

  it('answers from cache past the TTL and refreshes behind the request', async () => {
    const { service, multicall } = harness({ u: [account('a')] })
    await service.portfolio('u')
    vi.setSystemTime(Date.now() + 60_000)

    const snapshot = await service.portfolio('u')
    expect(snapshot.stale).toBe(true)
    expect(snapshot.accounts[0]!.state).toBe('ready')
    // The refresh was started, but nobody waited for it.
    expect(multicall).toHaveBeenCalledTimes(2)

    await vi.runAllTimersAsync()
    expect((await service.portfolio('u')).stale).toBe(false)
    expect(multicall).toHaveBeenCalledTimes(2)
  })

  it('keeps serving the last good balance when a refresh fails', async () => {
    const { service, multicall, getBalance } = harness({ u: [account('a')] })
    await service.portfolio('u')
    vi.setSystemTime(Date.now() + 60_000)
    multicall.mockRejectedValue(new Error('rpc down'))
    getBalance.mockRejectedValue(new Error('rpc down'))

    const snapshot = await service.portfolio('u', true)
    expect(snapshot.stale).toBe(true)
    expect(snapshot.accounts[0]!.state).toBe('ready')
    expect(snapshot.errors).toBe(0)
  })

  it('reads the chain again after the user’s transaction settles', async () => {
    const { service, multicall } = harness({ u: [account('a')] })
    await service.portfolio('u')
    service.invalidateUser('u')
    await service.portfolio('u')
    expect(multicall).toHaveBeenCalledTimes(2)
  })
})

describe('Intertrain chain check', () => {
  it('is not repeated on every read', async () => {
    const intertrain: Account = {
      id: 'i',
      networkId: 'intertrain-mainnet',
      address: 'mna1q8lye5pxhet776htmfrgf2ffrvztuf0j65dyuyjz',
      family: 'intertrain',
      ownershipStatus: 'verified',
    }
    const repo = {
      listAccounts: vi.fn(async () => [intertrain]),
      marketTokens: vi.fn(async () => []),
    } as unknown as PortfolioRepository
    const calls: string[] = []
    const rpc = {
      intertrainRequest: vi.fn(async (_network: unknown, method: string) => {
        calls.push(method)
        if (method === 'chain_info')
          return { chain_id: 'intertrain-1', native_asset: { symbol: 'WSK', decimals: 6 } }
        return { address: intertrain.address, balance: '1250000', nonce: 0, assets: {} }
      }),
    } as unknown as RpcManager
    const service = new BalanceService(repo, rpc, env)

    await service.portfolio('u', true)
    await service.portfolio('u', true)
    expect(calls.filter((method) => method === 'chain_info')).toHaveLength(1)
    expect(calls.filter((method) => method === 'account_get')).toHaveLength(2)
  })
})

describe('RPC endpoint order', () => {
  it('tries a node we run ourselves before the public Intertrain endpoint', () => {
    const network = NETWORKS.find((item) => item.networkId === 'intertrain-mainnet')!
    const manager = new RpcManager({
      INTERTRAIN_MAINNET_RPC_URLS: 'http://host.docker.internal:8545/rpc',
    } as unknown as Environment)
    expect(manager.urls(network)).toEqual([
      'http://host.docker.internal:8545/rpc',
      'https://rpc.intertrain.online/rpc',
    ])
  })

  it('still reaches the public endpoint when nothing is configured', () => {
    const network = NETWORKS.find((item) => item.networkId === 'intertrain-mainnet')!
    expect(new RpcManager({} as unknown as Environment).urls(network)).toEqual([
      'https://rpc.intertrain.online/rpc',
    ])
  })
})
