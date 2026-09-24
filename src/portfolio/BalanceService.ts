/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- Solana parsed-account payload is runtime RPC data */
import { PublicKey } from '@solana/web3.js'
import { formatUnits, isAddress, parseAbi } from 'viem'
import type { Environment } from '../config/env.js'
import { AppError } from '../utils/errors.js'
import { BALANCE_TOKENS, NETWORKS } from './networks.js'
import {
  isExpectedIntertrainChain,
  isIntertrainReservePriceable,
  parseIntertrainNativeBalance,
} from './intertrain.js'
import type { Account, PortfolioRepository } from './PortfolioRepository.js'
import type { RpcManager } from './RpcManager.js'

const erc20 = parseAbi(['function balanceOf(address owner) view returns (uint256)'])
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
  private cache = new Map<string, { expires: number; value: PortfolioSnapshot }>()
  private inflight = new Map<string, Promise<PortfolioSnapshot>>()
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
    const cached = this.cache.get(userId)
    if (!force && cached && cached.expires > Date.now()) return cached.value
    const active = this.inflight.get(userId)
    if (active) return active
    const job = this.load(userId)
      .then((value) => {
        this.cache.set(userId, { expires: Date.now() + this.env.BALANCE_CACHE_TTL_MS, value })
        return value
      })
      .catch((error) => {
        if (cached) return { ...cached.value, stale: true }
        throw error
      })
      .finally(() => this.inflight.delete(userId))
    this.inflight.set(userId, job)
    return job
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
  private async load(userId: string): Promise<PortfolioSnapshot> {
    const accounts = (await this.repo.listAccounts(userId)).filter(
        (account) => account.ownershipStatus === 'verified',
      ),
      results: AccountResult[] = []
    for (let i = 0; i < accounts.length; i += this.env.BALANCE_MAX_CONCURRENCY) {
      results.push(
        ...(await Promise.all(
          accounts.slice(i, i + this.env.BALANCE_MAX_CONCURRENCY).map((a) =>
            Promise.race([
              this.balance(a),
              new Promise<AccountResult>((resolve) =>
                setTimeout(
                  () =>
                    resolve({
                      accountId: a.id,
                      networkId: a.networkId,
                      address: a.address,
                      assets: [],
                      state: 'unavailable',
                      observedAt: new Date().toISOString(),
                      providerStatus: 'unavailable',
                      error: { code: 'BALANCE_UNAVAILABLE', message: 'Balance request timed out' },
                    }),
                  this.env.BALANCE_AGGREGATE_TIMEOUT_MS,
                ),
              ),
            ]),
          ),
        )),
      )
    }
    return {
      asOf: new Date().toISOString(),
      stale: false,
      accounts: results,
      errors: results.filter((r) => r.error).length,
    }
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
        const chainInfo = await this.rpc.intertrainRequest(network, 'chain_info')
        if (!isExpectedIntertrainChain(chainInfo))
          throw new AppError(
            'INTERTRAIN_NETWORK_MISMATCH',
            'RPC endpoint is not the expected Intertrain mainnet WSK chain',
            503,
          )
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
        if (typeof data?.address === 'string' && data.address.toLowerCase() !== account.address.toLowerCase())
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
        const client = this.rpc.evmClient(network),
          native = await client.getBalance({ address: account.address })
        const assets: AssetBalance[] = [
          {
            assetId: 'native',
            symbol: network.nativeSymbol,
            decimals: network.nativeDecimals,
            raw: native.toString(),
            formatted: formatUnits(native, network.nativeDecimals),
            supported: true,
          },
        ]
        for (const token of BALANCE_TOKENS[network.networkId] ?? []) {
          const raw = await client.readContract({
            address: token.address as `0x${string}`,
            abi: erc20,
            functionName: 'balanceOf',
            args: [account.address],
          })
          assets.push({
            assetId: token.address,
            symbol: token.symbol,
            decimals: token.decimals,
            raw: raw.toString(),
            formatted: formatUnits(raw, token.decimals),
            supported: true,
          })
        }
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
