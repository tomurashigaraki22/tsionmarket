import { Connection } from '@solana/web3.js'
import { createPublicClient, defineChain, fallback, http, type PublicClient } from 'viem'
import type { Environment } from '../config/env.js'
import { AppError } from '../utils/errors.js'
import type { Network } from './networks.js'

export class RpcManager {
  private evm = new Map<string, PublicClient>()
  private cooldowns = new Map<string, number>()
  constructor(private env: Environment) {}
  urls(network: Network): string[] {
    if (network.networkId === 'solana-devnet') return ['https://api.devnet.solana.com']
    const source = this.env as unknown as Record<string, unknown>
    return [
      ...new Set(
        network.rpcKeys.flatMap((key) => {
          const value = source[String(key)]
          return typeof value === 'string'
            ? value
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean)
            : []
        }),
      ),
    ]
  }
  evmClient(network: Network): PublicClient {
    const cached = this.evm.get(network.networkId)
    if (cached) return cached
    const urls = this.urls(network)
    if (!network.chainId || !urls.length)
      throw new AppError('RPC_NOT_CONFIGURED', `No RPC provider is configured for ${network.networkId}`, 503)
    const chain = defineChain({
      id: network.chainId,
      name: network.name,
      nativeCurrency: {
        name: network.nativeSymbol,
        symbol: network.nativeSymbol,
        decimals: network.nativeDecimals,
      },
      rpcUrls: { default: { http: urls } },
    })
    const client = createPublicClient({
      chain,
      transport: fallback(
        urls.map((url) =>
          http(url, { timeout: this.env.RPC_TIMEOUT_MS, retryCount: this.env.RPC_MAX_RETRIES }),
        ),
        { rank: false },
      ),
    })
    this.evm.set(network.networkId, client)
    return client
  }
  async solana<T>(network: Network, operation: (connection: Connection) => Promise<T>): Promise<T> {
    const urls = this.urls(network)
    if (!urls.length)
      throw new AppError('RPC_NOT_CONFIGURED', `No RPC provider is configured for ${network.networkId}`, 503)
    const now = Date.now(),
      available = urls.filter((url) => (this.cooldowns.get(`${network.networkId}:${url}`) ?? 0) <= now),
      candidates = available.length ? available : urls
    for (const url of candidates) {
      try {
        return await operation(
          new Connection(url, {
            commitment: 'confirmed',
            confirmTransactionInitialTimeout: this.env.RPC_TIMEOUT_MS,
          }),
        )
      } catch {
        this.cooldowns.set(`${network.networkId}:${url}`, Date.now() + this.env.RPC_PROVIDER_COOLDOWN_MS)
      }
    }
    throw new AppError('RPC_ALL_PROVIDERS_FAILED', `All RPC providers failed for ${network.networkId}`, 503)
  }
}
