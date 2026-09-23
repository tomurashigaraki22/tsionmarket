/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unnecessary-type-assertion -- provider JSON is validated and normalized field-by-field below */
import type { Environment } from '../config/env.js'
import { PublicKey } from '@solana/web3.js'
import { isAddress } from 'viem'
import { logger } from '../utils/logger.js'
import type { MarketInput, MarketRepository } from './MarketRepository.js'

const routes = [
  {
    id: 'lifi:ethereum-mainnet',
    venue: '0x',
    networkId: 'ethereum-mainnet',
    chainId: 1,
    url: 'https://li.quest/v1/tokens?chains=1',
    quote: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  },
  {
    id: 'lifi:arbitrum-one',
    venue: '0x',
    networkId: 'arbitrum-one',
    chainId: 42161,
    url: 'https://li.quest/v1/tokens?chains=42161',
    quote: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  },
  {
    id: 'jupiter:solana-mainnet-beta',
    venue: 'jupiter',
    networkId: 'solana-mainnet-beta',
    chainId: 0,
    url: 'https://api.jup.ag/tokens/v2/tag?query=verified',
    quote: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  },
] as const
const wrapped: Record<string, string> = {
  'ethereum-mainnet': '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  'arbitrum-one': '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
}
const numeric = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : null)
const validAddress = (venue: '0x' | 'jupiter', value: string): boolean => {
  if (venue === '0x') return isAddress(value)
  try {
    new PublicKey(value)
    return true
  } catch {
    return false
  }
}

export class MarketRegistryWorker {
  private initial?: NodeJS.Timeout
  private interval?: NodeJS.Timeout
  private running = false
  constructor(
    private repo: MarketRepository,
    private env: Environment,
  ) {}
  start() {
    if (!this.env.SPOT_MARKET_REGISTRY_ENABLED) {
      logger.info('Spot market registry disabled')
      return
    }
    this.initial = setTimeout(
      () => void this.sync(),
      this.env.SPOT_MARKET_REGISTRY_START_DELAY_SECONDS * 1000,
    )
    this.initial.unref()
    this.interval = setInterval(() => void this.sync(), this.env.SPOT_MARKET_REGISTRY_INTERVAL_SECONDS * 1000)
    this.interval.unref()
  }
  stop() {
    if (this.initial) clearTimeout(this.initial)
    if (this.interval) clearInterval(this.interval)
  }
  async sync() {
    if (this.running) return
    this.running = true
    try {
      for (const route of routes) await this.route(route)
    } finally {
      this.running = false
    }
  }
  private async route(route: (typeof routes)[number]) {
    try {
      const response = await fetch(route.url, {
        headers: {
          accept: 'application/json',
          ...(route.venue === 'jupiter' && this.env.JUPITER_API_KEY
            ? { 'x-api-key': this.env.JUPITER_API_KEY }
            : {}),
        },
        signal: AbortSignal.timeout(20_000),
      })
      if (!response.ok) throw new Error(`Token registry returned HTTP ${response.status}`)
      const body = (await response.json()) as any
      const raw = route.venue === 'jupiter' ? body : body.tokens?.[String(route.chainId)]
      const items = (Array.isArray(raw) ? raw : []).slice(
        0,
        this.env.SPOT_MARKET_REGISTRY_MAX_TOKENS_PER_ROUTE,
      )
      const markets: MarketInput[] = items
        .map((token: any) => {
          let address = String(token.address ?? token.id ?? '')
          if (address === '0x0000000000000000000000000000000000000000')
            address = wrapped[route.networkId] ?? address
          const symbol = String(token.symbol ?? '')
            .trim()
            .toUpperCase()
          const price = numeric(token.usdPrice ?? token.price ?? token.priceUSD),
            liquidity = numeric(token.liquidity ?? token.liquidityUsd)
          return {
            marketId: `${route.venue}:${route.networkId}:${address.toLowerCase()}:${route.quote.toLowerCase()}`,
            venue: route.venue,
            networkId: route.networkId,
            baseSymbol: symbol,
            quoteSymbol: 'USDC',
            baseToken: address,
            quoteToken: route.quote,
            decimals: Number(token.decimals ?? 18),
            priceUsd: price,
            liquidityUsd: liquidity,
            volume24hUsd: numeric(token.daily_volume ?? token.volume24h),
            iconUrl: token.icon ?? token.logoURI ?? token.extensions?.logoURI ?? null,
            chartSymbol: token.extensions?.coingeckoId ?? token.coingeckoId ?? symbol.toLowerCase(),
          }
        })
        .filter((m: MarketInput) =>
          Boolean(
            m.baseSymbol &&
            m.baseToken &&
            validAddress(route.venue, m.baseToken) &&
            m.baseToken.toLowerCase() !== route.quote.toLowerCase() &&
            (m.priceUsd ?? 0) > 0,
          ),
        )
      await this.repo.replaceRoute(route.id, route.networkId, route.venue, markets)
      logger.info('Spot market registry synced', { route: route.id, count: markets.length })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.repo.failed(route.id, message)
      logger.warn('Spot market registry route failed', { route: route.id, error: message })
    }
  }
}
