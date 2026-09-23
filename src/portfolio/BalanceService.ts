/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- Solana parsed-account payload is runtime RPC data */
import { PublicKey } from '@solana/web3.js'
import { formatUnits, isAddress, parseAbi } from 'viem'
import type { Environment } from '../config/env.js'
import { AppError } from '../utils/errors.js'
import { BALANCE_TOKENS, NETWORKS } from './networks.js'
import type { Account, PortfolioRepository } from './PortfolioRepository.js'
import type { RpcManager } from './RpcManager.js'

const erc20 = parseAbi(['function balanceOf(address owner) view returns (uint256)'])
type AssetBalance = { assetId: string; symbol: string; decimals: number; raw: string; formatted: string }
type AccountResult = {
  accountId: string
  networkId: string
  address: string
  assets: AssetBalance[]
  state: 'ready' | 'unavailable'
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
  private async load(userId: string): Promise<PortfolioSnapshot> {
    const accounts = await this.repo.listAccounts(userId),
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
        error: { code: 'NETWORK_UNSUPPORTED', message: 'Network is not supported' },
      }
    try {
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
          })
        }
        return {
          accountId: account.id,
          networkId: account.networkId,
          address: account.address,
          assets,
          state: 'ready',
        }
      }
      const owner = new PublicKey(account.address),
        assets: AssetBalance[] = []
      await this.rpc.solana(network, async (connection) => {
        const [lamports, tokens] = await Promise.all([
          connection.getBalance(owner),
          connection.getParsedTokenAccountsByOwner(owner, {
            programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
          }),
        ])
        assets.push({
          assetId: 'native',
          symbol: 'SOL',
          decimals: 9,
          raw: String(lamports),
          formatted: formatUnits(BigInt(lamports), 9),
        })
        const allow = new Map((BALANCE_TOKENS[network.networkId] ?? []).map((t) => [t.address, t]))
        for (const row of tokens.value) {
          const info = row.account.data.parsed.info,
            meta = allow.get(info.mint)
          if (meta)
            assets.push({
              assetId: info.mint,
              symbol: meta.symbol,
              decimals: meta.decimals,
              raw: info.tokenAmount.amount,
              formatted: formatUnits(BigInt(info.tokenAmount.amount), meta.decimals),
            })
        }
      })
      return {
        accountId: account.id,
        networkId: account.networkId,
        address: account.address,
        assets,
        state: 'ready',
      }
    } catch (error) {
      return {
        accountId: account.id,
        networkId: account.networkId,
        address: account.address,
        assets: [],
        state: 'unavailable',
        error: {
          code: error instanceof AppError ? error.code : 'BALANCE_UNAVAILABLE',
          message: error instanceof AppError ? error.message : 'Balance temporarily unavailable',
        },
      }
    }
  }
}
