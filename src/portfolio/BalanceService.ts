/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- Solana parsed-account payload is runtime RPC data */
import { PublicKey } from '@solana/web3.js'
import { formatUnits, isAddress, parseAbi } from 'viem'
import type { Environment } from '../config/env.js'
import { AppError } from '../utils/errors.js'
import { BALANCE_TOKENS, NETWORKS } from './networks.js'
import {
  isExpectedIntertrainChain,
  isIntertrainReservePriceable,
  isSameIntertrainAddress,
  parseIntertrainNativeBalance,
} from './intertrain.js'
import type { Account, PortfolioRepository } from './PortfolioRepository.js'
import type { RpcManager } from './RpcManager.js'
import type { Network } from './networks.js'

const erc20 = parseAbi(['function balanceOf(address owner) view returns (uint256)'])
// Multicall3 is deployed at the same address on every chain we support, and its
// getEthBalance lets the native balance ride in the same call as the tokens.
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const
const batchReads = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function getEthBalance(address addr) view returns (uint256)',
])
/** The chain-identity check is a guard, not a per-read cost. */
const INTERTRAIN_CHAIN_TTL_MS = 60_000
/** How long a balance may be served while a fresh one loads behind it. */
const DEFAULT_STALE_TTL_MS = 5 * 60_000
const MAX_CACHED_ACCOUNTS = 5_000
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
type AssetBalance = {
  assetId: string
  symbol: string
  decimals: number
  raw: string
  formatted: string
  supported: true
}
type AccountResult = {
  accountId: string
  networkId: string
  address: string
  assets: AssetBalance[]
  state: 'ready' | 'unavailable'
  observedAt: string
  providerStatus: 'fresh' | 'unavailable'
  error?: { code: string; message: string }
}
export type PortfolioSnapshot = { asOf: string; stale: boolean; accounts: AccountResult[]; errors: number }

export class BalanceService {
  // Cached per address, not per user: the chain does not care who is asking,
  // and a wallet opened twice (two tabs, valuation plus balances) is one read.
  private accounts = new Map<string, { at: number; value: AccountResult }>()
  private refreshing = new Map<string, Promise<AccountResult>>()
  private userKeys = new Map<string, Set<string>>()
  private intertrainChainOkAt = 0
  constructor(
    private repo: PortfolioRepository,
    private rpc: RpcManager,
    private env: Environment,
  ) {}
  async assetBalance(userId: string, accountId: string, token: string): Promise<AssetBalance> {
    const account = (await this.repo.listAccounts(userId)).find(
      (item) => item.id === accountId && item.ownershipStatus === 'verified',
    )
    if (!account) throw new AppError('ACCOUNT_NOT_FOUND', 'Verified account not found', 404)
    const network = NETWORKS.find((item) => item.networkId === account.networkId)
    if (!network) throw new AppError('NETWORK_UNSUPPORTED', 'Network is not supported', 400)
    if (network.family === 'intertrain') {
      if (token !== 'native')
        throw new AppError('TOKEN_NOT_LISTED', 'Only native WSK is supported on Intertrain', 400)
      const snapshot = await this.portfolio(userId)
      const result = snapshot.accounts.find((item) => item.accountId === accountId)
      if (result?.state !== 'ready')
        throw new AppError(
          'BALANCE_UNAVAILABLE',
          result?.error?.message ?? 'Balance provider unavailable',
          503,
        )
      const native = result.assets.find((asset) => asset.assetId === 'native')
      if (!native) throw new AppError('BALANCE_UNAVAILABLE', 'Native WSK balance was not returned', 503)
      return native
    }
    const known = [
      ...(await this.repo.marketTokens(account.networkId)),
      ...(BALANCE_TOKENS[account.networkId] ?? []),
    ].find((item) => item.address.toLowerCase() === token.toLowerCase())
    if (!known) throw new AppError('TOKEN_NOT_LISTED', 'Token is not listed on this network', 400)
    const native =
      token === 'So11111111111111111111111111111111111111112' ||
      ['0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'].some(
        (wrapped) => wrapped.toLowerCase() === token.toLowerCase(),
      )
    if (network.family === 'solana') {
      const snapshot = await this.portfolio(userId)
      const result = snapshot.accounts.find((item) => item.accountId === accountId)
      if (result?.state !== 'ready')
        throw new AppError(
          'BALANCE_UNAVAILABLE',
          result?.error?.message ?? 'Balance provider unavailable',
          503,
        )
      const asset = result.assets.find(
        (item) => item.assetId === token || (native && item.assetId === 'native'),
      )
      return (
        asset ?? {
          assetId: token,
          symbol: known.symbol,
          decimals: known.decimals,
          raw: '0',
          formatted: '0',
          supported: true,
        }
      )
    }
    const client = this.rpc.evmClient(network)
    const raw = native
      ? await client.getBalance({ address: account.address as `0x${string}` })
      : await client.readContract({
          address: token as `0x${string}`,
          abi: erc20,
          functionName: 'balanceOf',
          args: [account.address as `0x${string}`],
        })
    const decimals = native ? network.nativeDecimals : known.decimals
    return {
      assetId: native ? 'native' : token,
      symbol: native ? network.nativeSymbol : known.symbol,
      decimals,
      raw: raw.toString(),
      formatted: formatUnits(raw, decimals),
      supported: true,
    }
  }
  async portfolio(userId: string, force = false): Promise<PortfolioSnapshot> {
    const accounts = (await this.repo.listAccounts(userId)).filter(
      (account) => account.ownershipStatus === 'verified',
    )
    this.userKeys.set(userId, new Set(accounts.map(cacheKey)))
    if (this.userKeys.size > MAX_CACHED_ACCOUNTS) {
      const oldest = this.userKeys.keys().next().value
      if (oldest !== undefined) this.userKeys.delete(oldest)
    }
    const results: AccountResult[] = []
    let stale = false
    for (let i = 0; i < accounts.length; i += this.env.BALANCE_MAX_CONCURRENCY) {
      const batch = await Promise.all(
        accounts.slice(i, i + this.env.BALANCE_MAX_CONCURRENCY).map((account) => this.read(account, force)),
      )
      for (const item of batch) {
        results.push(item.result)
        stale ||= item.stale
      }
    }
    return {
      asOf: new Date().toISOString(),
      stale,
      accounts: results,
      errors: results.filter((r) => r.error).length,
    }
  }
  /**
   * Drops what is cached for a user's wallets, so the next read goes to the
   * chain. Called when one of their transactions settles: that is the moment
   * the cached number is known to be wrong.
   */
  invalidateUser(userId: string): void {
    for (const key of this.userKeys.get(userId) ?? []) this.accounts.delete(key)
  }
  async intertrainNativeUsdPrice(): Promise<{
    priceUsd: string
    observedAt: string
    provenance: string
  } | null> {
    const network = NETWORKS.find((item) => item.networkId === 'intertrain-mainnet')
    if (!network) return null
    try {
      const chainInfo = await this.rpc.intertrainRequest(network, 'chain_info')
      if (!isExpectedIntertrainChain(chainInfo)) return null
      const reserve = await this.rpc.intertrainRequest(network, 'mna_reserve_status')
      if (!isIntertrainReservePriceable(reserve)) return null
      return {
        priceUsd: '1.00000000',
        observedAt: new Date().toISOString(),
        provenance: 'intertrain_mna_reserve_status',
      }
    } catch {
      return null
    }
  }
  /**
   * Fresh within the TTL; between the TTL and the stale window it answers from
   * cache and refreshes behind the request, so a user opening the app is never
   * made to wait on a chain read they have effectively already paid for.
   */
  private async read(account: Account, force: boolean): Promise<{ result: AccountResult; stale: boolean }> {
    const key = cacheKey(account)
    const entry = this.accounts.get(key)
    const staleTtl = this.env.BALANCE_STALE_TTL_MS || DEFAULT_STALE_TTL_MS
    const asOwn = (value: AccountResult): AccountResult => ({ ...value, accountId: account.id })
    if (!force && entry) {
      const age = Date.now() - entry.at
      if (age < this.env.BALANCE_CACHE_TTL_MS) return { result: asOwn(entry.value), stale: false }
      if (age < staleTtl) {
        void this.refresh(account, key)
        return { result: asOwn(entry.value), stale: true }
      }
    }
    const fresh = await Promise.race([
      this.refresh(account, key),
      new Promise<AccountResult>((resolve) =>
        setTimeout(
          () => resolve(unavailable(account, 'Balance request timed out')),
          this.env.BALANCE_AGGREGATE_TIMEOUT_MS,
        ),
      ),
    ])
    if (fresh.state === 'ready') return { result: asOwn(fresh), stale: false }
    if (entry && Date.now() - entry.at < staleTtl) return { result: asOwn(entry.value), stale: true }
    return { result: fresh, stale: false }
  }
  private refresh(account: Account, key: string): Promise<AccountResult> {
    const active = this.refreshing.get(key)
    if (active) return active
    const job = this.balance(account)
      .then((value) => {
        if (value.state === 'ready') {
          this.accounts.delete(key)
          this.accounts.set(key, { at: Date.now(), value })
          if (this.accounts.size > MAX_CACHED_ACCOUNTS) {
            const oldest = this.accounts.keys().next().value
            if (oldest !== undefined) this.accounts.delete(oldest)
          }
        }
        return value
      })
      .finally(() => this.refreshing.delete(key))
    this.refreshing.set(key, job)
    return job
  }
  private async evmAssets(network: Network, address: `0x${string}`): Promise<AssetBalance[]> {
    const client = this.rpc.evmClient(network)
    const tokens = BALANCE_TOKENS[network.networkId] ?? []
    const nativeAsset = (raw: bigint): AssetBalance => ({
      assetId: 'native',
      symbol: network.nativeSymbol,
      decimals: network.nativeDecimals,
      raw: raw.toString(),
      formatted: formatUnits(raw, network.nativeDecimals),
      supported: true,
    })
    const tokenAsset = (token: (typeof tokens)[number], raw: bigint): AssetBalance => ({
      assetId: token.address,
      symbol: token.symbol,
      decimals: token.decimals,
      raw: raw.toString(),
      formatted: formatUnits(raw, token.decimals),
      supported: true,
    })
    // One round trip for the native balance and every token, instead of 1 + N.
    try {
      // Mixed function names defeat viem's tuple inference; the shape is
      // fixed here and the result is checked below, so the cast is contained.
      const contracts = [
        { address: MULTICALL3, abi: batchReads, functionName: 'getEthBalance', args: [address] },
        ...tokens.map((token) => ({
          address: token.address as `0x${string}`,
          abi: batchReads,
          functionName: 'balanceOf',
          args: [address],
        })),
      ]
      const values: unknown[] = await client.multicall({
        multicallAddress: MULTICALL3,
        allowFailure: false,
        contracts: contracts as never,
      })
      if (values.length === tokens.length + 1 && values.every((value) => typeof value === 'bigint'))
        return [
          nativeAsset(values[0] as bigint),
          ...tokens.map((token, i) => tokenAsset(token, values[i + 1] as bigint)),
        ]
    } catch {
      // A node without multicall support still answers the plain calls below.
    }
    const assets = [nativeAsset(await client.getBalance({ address }))]
    for (const token of tokens)
      assets.push(
        tokenAsset(
          token,
          await client.readContract({
            address: token.address as `0x${string}`,
            abi: erc20,
            functionName: 'balanceOf',
            args: [address],
          }),
        ),
      )
    return assets
  }
  private async balance(account: Account): Promise<AccountResult> {
    const network = NETWORKS.find((n) => n.networkId === account.networkId)
    if (!network)
      return {
        accountId: account.id,
        networkId: account.networkId,
        address: account.address,
        assets: [],
        state: 'unavailable',
        observedAt: new Date().toISOString(),
        providerStatus: 'unavailable',
        error: { code: 'NETWORK_UNSUPPORTED', message: 'Network is not supported' },
      }
    try {
      if (network.family === 'intertrain') {
        if (Date.now() - this.intertrainChainOkAt > INTERTRAIN_CHAIN_TTL_MS) {
          const chainInfo = await this.rpc.intertrainRequest(network, 'chain_info')
          if (!isExpectedIntertrainChain(chainInfo))
            throw new AppError(
              'INTERTRAIN_NETWORK_MISMATCH',
              'RPC endpoint is not the expected Intertrain mainnet WSK chain',
              503,
            )
          this.intertrainChainOkAt = Date.now()
        }
        const response = await this.rpc.intertrainRequest(network, 'account_get', {
          address: account.address,
        })
        const raw = parseIntertrainNativeBalance(response)
        if (raw === null)
          throw new AppError(
            'INTERTRAIN_RPC_RESPONSE_INVALID',
            'Intertrain returned an invalid native balance',
            503,
          )
        const data =
          typeof response === 'object' && response !== null ? (response as Record<string, unknown>) : null
        if (typeof data?.address === 'string' && !isSameIntertrainAddress(data.address, account.address))
          throw new AppError(
            'INTERTRAIN_RPC_ADDRESS_MISMATCH',
            'Intertrain returned a balance for a different address',
            503,
          )
        return {
          accountId: account.id,
          networkId: account.networkId,
          address: account.address,
          assets: [
            {
              assetId: 'native',
              symbol: 'WSK',
              decimals: 6,
              raw,
              formatted: formatUnits(BigInt(raw), 6),
              supported: true,
            },
          ],
          state: 'ready',
          observedAt: new Date().toISOString(),
          providerStatus: 'fresh',
        }
      }
      if (network.family === 'evm') {
        if (!isAddress(account.address)) throw new AppError('INVALID_ADDRESS', 'Invalid EVM address', 400)
        const assets = await this.evmAssets(network, account.address)
        return {
          accountId: account.id,
          networkId: account.networkId,
          address: account.address,
          assets,
          state: 'ready',
          observedAt: new Date().toISOString(),
          providerStatus: 'fresh',
        }
      }
      const owner = new PublicKey(account.address),
        assets: AssetBalance[] = []
      const marketTokens = await this.repo.marketTokens(network.networkId)
      await this.rpc.solana(network, async (connection) => {
        const [lamports, legacyTokens, token2022] = await Promise.all([
          connection.getBalance(owner),
          connection.getParsedTokenAccountsByOwner(owner, {
            programId: TOKEN_PROGRAM,
          }),
          connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM }),
        ])
        assets.push({
          assetId: 'native',
          symbol: 'SOL',
          decimals: 9,
          raw: String(lamports),
          formatted: formatUnits(BigInt(lamports), 9),
          supported: true,
        })
        const allow = new Map(
          [...marketTokens, ...(BALANCE_TOKENS[network.networkId] ?? [])].map((t) => [t.address, t]),
        )
        const holdings = new Map<string, { raw: bigint; decimals: number }>()
        for (const row of [...legacyTokens.value, ...token2022.value]) {
          const info = row.account.data.parsed.info,
            meta = allow.get(info.mint)
          if (!meta) continue
          const current = holdings.get(info.mint)
          holdings.set(info.mint, {
            raw: (current?.raw ?? 0n) + BigInt(info.tokenAmount.amount),
            decimals: Number(info.tokenAmount.decimals),
          })
        }
        for (const [mint, holding] of holdings) {
          const meta = allow.get(mint)!
          assets.push({
            assetId: mint,
            symbol: meta.symbol,
            decimals: holding.decimals,
            raw: holding.raw.toString(),
            formatted: formatUnits(holding.raw, holding.decimals),
            supported: true,
          })
        }
      })
      return {
        accountId: account.id,
        networkId: account.networkId,
        address: account.address,
        assets,
        state: 'ready',
        observedAt: new Date().toISOString(),
        providerStatus: 'fresh',
      }
    } catch (error) {
      return {
        accountId: account.id,
        networkId: account.networkId,
        address: account.address,
        assets: [],
        state: 'unavailable',
        observedAt: new Date().toISOString(),
        providerStatus: 'unavailable',
        error: {
          code: error instanceof AppError ? error.code : 'BALANCE_UNAVAILABLE',
          message: error instanceof AppError ? error.message : 'Balance temporarily unavailable',
        },
      }
    }
  }
}

const cacheKey = (account: Account) => `${account.networkId}:${account.address.toLowerCase()}`

function unavailable(account: Account, message: string): AccountResult {
  return {
    accountId: account.id,
    networkId: account.networkId,
    address: account.address,
    assets: [],
    state: 'unavailable',
    observedAt: new Date().toISOString(),
    providerStatus: 'unavailable',
    error: { code: 'BALANCE_UNAVAILABLE', message },
  }
}
