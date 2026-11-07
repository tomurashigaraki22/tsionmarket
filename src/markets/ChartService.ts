/**
 * Candles for any market in the catalogue, keyed by CONTRACT ADDRESS.
 *
 * A symbol cannot be the key: 'TRUMP' names several unrelated tokens across
 * chains, and most of this catalogue is long-tail SPL and ERC-20 that no
 * centralised venue lists. The only thing identifying a market unambiguously
 * is the mint/contract, which the registry already stores.
 *
 * Three sources, tried in order. Birdeye and GeckoTerminal both serve real
 * per-bar OHLC; Birdeye goes first because it is address-keyed on every chain
 * we route and serves every interval, where a pool has to exist and be the
 * deepest one. CoinGecko is last and different in kind — a sampled price line
 * — which is why the payload names its source and drops the intervals that
 * source cannot support.
 *
 * This lives on the backend rather than in the browser so upstreams see one
 * cached origin instead of every open tab, and so a rate limit degrades into a
 * stale-but-honest chart rather than a CORS failure in the console.
 */

import type { Environment } from '../config/env.js'
import {
  INTERVAL_SECONDS,
  bucketPrices,
  normalizeBirdeye,
  normalizeOhlcv,
  num,
  stats24hFrom,
  type ChartPayload,
  type ChartSource,
} from './chartData.js'

const GECKO = 'https://api.geckoterminal.com/api/v2'
const COINGECKO = 'https://api.coingecko.com/api/v3'
const BIRDEYE = 'https://public-api.birdeye.so'

/** Our network ids → each upstream's own chain identifier. */
const BIRDEYE_CHAIN: Record<string, string> = {
  'solana-mainnet-beta': 'solana',
  'ethereum-mainnet': 'ethereum',
  'arbitrum-one': 'arbitrum',
}
const CHAIN_SLUG: Record<string, string> = {
  'solana-mainnet-beta': 'solana',
  'ethereum-mainnet': 'eth',
  'arbitrum-one': 'arbitrum',
}

const BIRDEYE_TYPE: Record<string, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1H',
  '4h': '4H',
  '1d': '1D',
}

/**
 * GeckoTerminal only accepts these aggregates (minute 1/5/15, hour 1/4/12,
 * day 1), so the interval buttons are constrained to what exists rather than
 * asking for a bar that comes back empty.
 */
const TIMEFRAME: Record<string, { timeframe: string; aggregate: number }> = {
  '1m': { timeframe: 'minute', aggregate: 1 },
  '5m': { timeframe: 'minute', aggregate: 5 },
  '15m': { timeframe: 'minute', aggregate: 15 },
  '1h': { timeframe: 'hour', aggregate: 1 },
  '4h': { timeframe: 'hour', aggregate: 4 },
  '1d': { timeframe: 'day', aggregate: 1 },
}

/**
 * Days of samples to ask CoinGecko for, per interval. Its free tier picks
 * sample spacing from the window: one day gives 5-minutely points, up to
 * ninety gives hourly, beyond that daily. These are the smallest windows whose
 * samples can still fill the requested bar.
 *
 * '1m' is absent deliberately — the finest sample is five minutes, and no
 * window makes a one-minute bar out of it.
 */
const COINGECKO_DAYS: Record<string, number> = { '5m': 1, '15m': 1, '1h': 90, '4h': 90, '1d': 365 }

const ALL_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d']
const COINGECKO_INTERVALS = Object.keys(COINGECKO_DAYS)
const BIRDEYE_BARS = 1000
const UPSTREAM_TIMEOUT_MS = 8_000
const MAX_CACHE_ENTRIES = 500

/**
 * GeckoTerminal's public API allows roughly thirty calls a minute per IP and
 * answers a burst with 429. Every chart open costs calls, and this one origin
 * serves every viewer, so calls are spaced out here rather than fired in
 * parallel and rejected.
 */
const GECKO_SPACING_MS = 2_200
const GECKO_MAX_QUEUE_MS = 12_000
const GECKO_MAX_COOLDOWN_MS = 20_000
/** How long a good chart may be served when every source is failing. */
const LAST_GOOD_TTL_MS = 2 * 60 * 60_000
const VOLUME_TTL_MS = 5 * 60_000

/** A source failed to answer. Not the same as answering "nothing here". */
class UpstreamUnavailable extends Error {}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

type CacheEntry<T> = { value: T; expires: number }

export class ChartService {
  /** Ranked pools, retained so a newly-created deepest pool cannot truncate history. */
  private readonly pools = new Map<string, CacheEntry<Array<string>>>()
  private readonly charts = new Map<string, CacheEntry<ChartPayload>>()
  /** The last non-empty answer per chart, served if every source later fails. */
  private readonly lastGood = new Map<string, CacheEntry<ChartPayload>>()
  private readonly volumes = new Map<string, CacheEntry<number | null>>()
  private geckoNext = 0
  /** One upstream round-trip per key, however many viewers ask at once. */
  private readonly inflight = new Map<string, Promise<ChartPayload>>()

  constructor(
    private readonly env: Environment,
    private readonly options: { geckoSpacingMs?: number } = {},
  ) {}

  async candles(input: {
    networkId: string
    token: string
    interval: string
    coinId?: string | undefined
    before?: number | undefined
    source?: ChartSource | undefined
  }): Promise<ChartPayload> {
    const key = `${input.networkId}:${input.token.toLowerCase()}:${input.coinId ?? ''}:${input.interval}:${input.before ?? 'latest'}:${input.source ?? 'auto'}`
    const hit = read(this.charts, key)
    if (hit) return hit

    const running = this.inflight.get(key)
    if (running) return running

    const work = this.resolve(input)
      .then((payload) => {
        // Intraday bars move; a daily bar does not. An empty answer is cached
        // briefly too, so an unlisted token is not re-asked on every poll —
        // but briefly, because empty is often a transient provider miss.
        if (payload.candles.length > 0) write(this.lastGood, key, payload, LAST_GOOD_TTL_MS)
        // Every source failing is not the same as the token having no chart:
        // keep showing the last good one, and ask again within seconds.
        const fallback =
          payload.candles.length === 0 && payload.degraded ? read(this.lastGood, key) : undefined
        const answer = fallback ?? payload
        const ttl =
          answer.candles.length === 0
            ? payload.degraded
              ? 3_000
              : 10_000
            : fallback
              ? 3_000
              : input.interval === '1d'
                ? 5 * 60_000
                : 45_000
        write(this.charts, key, answer, ttl)
        return answer
      })
      .finally(() => this.inflight.delete(key))

    this.inflight.set(key, work)
    return work
  }

  private async resolve(input: {
    networkId: string
    token: string
    interval: string
    coinId?: string | undefined
    before?: number | undefined
    source?: ChartSource | undefined
  }): Promise<ChartPayload> {
    const { networkId, token, interval, coinId, before, source } = input
    let degraded = false
    const attempt = async (work: () => Promise<ChartPayload | null>): Promise<ChartPayload | null> => {
      try {
        return await work()
      } catch {
        degraded = true
        return null
      }
    }

    // Each provider gets its own budget: a slow or rate-limited first source
    // must not consume the time the fallbacks need.
    if (token) {
      const priced =
        source && source !== 'birdeye'
          ? null
          : await attempt(() => this.fromBirdeye(networkId, token, interval, before))
      if (priced) return priced

      const pooled =
        source && source !== 'geckoterminal'
          ? null
          : await attempt(() => this.fromPool(networkId, token, interval, before))
      if (pooled) return pooled
    }
    if (coinId) {
      const listed =
        source && source !== 'coingecko'
          ? null
          : await attempt(() => this.fromCoingecko(coinId, interval, before))
      if (listed) return listed
    }

    // Nothing could draw this token. Report which intervals a source COULD
    // have served, so the chart does not disable every button on a transient
    // miss.
    return {
      candles: [],
      stats: null,
      source: null,
      intervals: coinId && !token ? COINGECKO_INTERVALS : ALL_INTERVALS,
      nextCursor: null,
      ...(degraded ? { degraded: true } : {}),
    }
  }

  /** Address-keyed OHLCV on every chain we route, at every interval. */
  private async fromBirdeye(
    networkId: string,
    token: string,
    interval: string,
    before?: number,
  ): Promise<ChartPayload | null> {
    const chain = BIRDEYE_CHAIN[networkId]
    const type = BIRDEYE_TYPE[interval]
    const seconds = INTERVAL_SECONDS[interval]
    const apiKey = this.env.BIRDEYE_API_KEY
    if (!chain || !type || !seconds || !apiKey) return null

    const to = before ? before - 1 : Math.floor(Date.now() / 1000)
    const url = new URL(`${BIRDEYE}/defi/ohlcv`)
    url.searchParams.set('address', token)
    url.searchParams.set('type', type)
    url.searchParams.set('time_from', String(to - seconds * BIRDEYE_BARS))
    url.searchParams.set('time_to', String(to))

    const response = await fetch(url, {
      headers: { accept: 'application/json', 'X-API-KEY': apiKey, 'x-chain': chain },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    // A 429 is routine on a free key: move to the next source, but remember
    // that this one did not actually answer.
    if (response.status === 429 || response.status >= 500)
      throw new UpstreamUnavailable(`Birdeye returned ${response.status}`)
    if (!response.ok) return null

    const body = (await response.json()) as {
      success?: boolean
      data?: { items?: Array<Record<string, unknown>> }
    }
    if (body.success === false) return null

    const candles = normalizeBirdeye(body.data?.items)
    if (candles.length === 0) return null

    const cutoff = (candles.at(-1)?.time ?? 0) - 24 * 60 * 60
    const volume24h = candles
      .filter((candle) => candle.time >= cutoff)
      .reduce((sum, candle) => sum + candle.volume, 0)

    return {
      candles,
      stats: { ...stats24hFrom(candles), volume24h: volume24h > 0 ? volume24h : null },
      source: 'birdeye',
      intervals: ALL_INTERVALS,
      nextCursor: candles[0]?.time ?? null,
    }
  }

  /**
   * OHLCV from the deepest pool holding this token. If that pool is too new
   * to answer an older cursor, walk the ranked candidates and continue from a
   * pool that actually has bars before the cursor. This keeps a fresh pool
   * from making an established market look like it has only a few hours of
   * history.
   */
  private async fromPool(
    networkId: string,
    token: string,
    interval: string,
    before?: number,
  ): Promise<ChartPayload | null> {
    const slug = CHAIN_SLUG[networkId]
    const timeframe = TIMEFRAME[interval]
    if (!slug || !timeframe) return null

    const pools = await this.findPools(slug, token)
    let unavailable = false
    for (const pool of pools) {
      try {
        const url = new URL(`${GECKO}/networks/${slug}/pools/${pool}/ohlcv/${timeframe.timeframe}`)
        url.searchParams.set('aggregate', String(timeframe.aggregate))
        url.searchParams.set('limit', '1000')
        url.searchParams.set('currency', 'usd')
        // Price OUR token, not the pool's base. In a TOKEN/SOL pool the base is
        // the token, but in a USDC/TOKEN pool it is not, and charting the base
        // blindly would draw the price upside down.
        url.searchParams.set('token', token)
        if (before) url.searchParams.set('before_timestamp', String(before - 1))

        const ohlcv = await this.geckoFetch(url)
        if (ohlcv.status >= 500) throw new UpstreamUnavailable(`GeckoTerminal returned ${ohlcv.status}`)
        if (!ohlcv.ok) continue

        const body = (await ohlcv.json()) as {
          data?: { attributes?: { ohlcv_list?: Array<Array<number | string>> } }
        }
        let candles = normalizeOhlcv(body.data?.attributes?.ohlcv_list)
        // A few upstream responses include the boundary bar even when
        // before_timestamp is set. Remove it so every page is strictly older.
        if (before) candles = candles.filter((candle) => candle.time < before)
        if (candles.length === 0) continue

        // Price and change come from the series, which is priced in our token.
        // Volume is a property of the pool and reads the same from either side.
        // It is optional and slow-moving, so it is cached and never allowed to
        // cost the chart a rate-limit slot on every open.
        const volume24h = before ? null : await this.poolVolume(slug, pool)

        return {
          candles,
          stats: { ...stats24hFrom(candles), volume24h },
          source: 'geckoterminal',
          intervals: ALL_INTERVALS,
          nextCursor: candles[0]?.time ?? null,
        }
      } catch {
        // One pool timing out must not hide older bars available in the next
        // ranked pool, but it must not be mistaken for "no data" either.
        unavailable = true
        continue
      }
    }
    if (unavailable) throw new UpstreamUnavailable('GeckoTerminal did not answer')
    return null
  }

  /**
   * The registry admits a token when CoinGecko has a chart for it, so a
   * staked, wrapped or bridged token often has a price here and no DEX pool
   * anywhere. Without this, those markets would show a price in the list and a
   * blank chart beside it.
   */
  private async fromCoingecko(
    coinId: string,
    interval: string,
    before?: number,
  ): Promise<ChartPayload | null> {
    // CoinGecko's sampled chart endpoint has no older-page cursor. Never mix
    // those samples with OHLC bars from a different provider.
    if (before) return null
    const days = COINGECKO_DAYS[interval] ?? COINGECKO_DAYS['1h']
    const url = new URL(`${COINGECKO}/coins/${encodeURIComponent(coinId)}/market_chart`)
    url.searchParams.set('vs_currency', 'usd')
    url.searchParams.set('days', String(days))

    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        ...(this.env.COINGECKO_API_KEY ? { 'x-cg-demo-api-key': this.env.COINGECKO_API_KEY } : {}),
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    if (!response.ok) return null

    const body = (await response.json()) as { prices?: Array<Array<number>> }
    const candles = bucketPrices(body.prices, INTERVAL_SECONDS[interval] ?? 60 * 60)
    if (candles.length === 0) return null

    return {
      candles,
      // Volume is not in a price series, so it is absent rather than invented.
      stats: { ...stats24hFrom(candles), volume24h: null },
      source: 'coingecko',
      intervals: COINGECKO_INTERVALS,
      nextCursor: null,
    }
  }

  /**
   * Every GeckoTerminal call goes through here: spaced to stay under its
   * limit, and after a 429 the whole service backs off together rather than
   * each viewer finding out separately.
   */
  private async geckoFetch(url: string | URL): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const slot = Math.max(Date.now(), this.geckoNext)
      if (slot - Date.now() > GECKO_MAX_QUEUE_MS) throw new UpstreamUnavailable('GeckoTerminal queue is full')
      this.geckoNext = slot + (this.options.geckoSpacingMs ?? GECKO_SPACING_MS)
      const wait = slot - Date.now()
      if (wait > 0) await sleep(wait)

      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      })
      if (response.status !== 429) return response

      const retryAfter = Number(response.headers.get('retry-after'))
      const cooldown = Math.min(
        GECKO_MAX_COOLDOWN_MS,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 6_000,
      )
      this.geckoNext = Math.max(this.geckoNext, Date.now() + cooldown)
      // One patient retry when the wait is short; otherwise tell the caller.
      if (attempt === 1 || cooldown > 8_000) throw new UpstreamUnavailable('GeckoTerminal rate limited')
    }
    throw new UpstreamUnavailable('GeckoTerminal rate limited')
  }

  private async poolVolume(slug: string, pool: string): Promise<number | null> {
    const key = `${slug}:${pool}`
    const hit = read(this.volumes, key)
    if (hit !== undefined) return hit
    try {
      const response = await this.geckoFetch(`${GECKO}/networks/${slug}/pools/${pool}`)
      if (!response.ok) return null
      const detail = (await response.json()) as {
        data?: { attributes?: { volume_usd?: Record<string, string> } }
      }
      const volume = num(detail.data?.attributes?.volume_usd?.h24)
      write(this.volumes, key, volume, VOLUME_TTL_MS)
      return volume
    } catch {
      return null
    }
  }

  private async findPools(slug: string, token: string): Promise<Array<string>> {
    const key = `${slug}:${token.toLowerCase()}`
    const hit = read(this.pools, key)
    if (hit !== undefined) return hit

    const response = await this.geckoFetch(
      `${GECKO}/networks/${slug}/tokens/${encodeURIComponent(token)}/pools?page=1`,
    )
    if (!response.ok) {
      // Only a genuine 404 means the token has no pool. A rate limit or outage
      // is not proof of that, and is reported as such so nothing is cached as
      // "unlisted" and the chart retries.
      if (response.status === 404) {
        write(this.pools, key, [], 10 * 60_000)
        return []
      }
      throw new UpstreamUnavailable(`GeckoTerminal returned ${response.status}`)
    }
    const body = (await response.json()) as {
      data?: Array<{ id?: string; attributes?: { address?: string; reserve_in_usd?: string } }>
    }
    const pools = (body.data ?? [])
      .map((row) => ({
        address:
          row.attributes?.address ??
          String(row.id ?? '')
            .split('_')
            .slice(1)
            .join('_'),
        liquidity: num(row.attributes?.reserve_in_usd) ?? 0,
      }))
      .filter((row) => row.address)
      .sort((left, right) => right.liquidity - left.liquidity)
      .map((row) => row.address)
    write(this.pools, key, pools, pools.length ? 60 * 60_000 : 10 * 60_000)
    return pools
  }
}

function read<T>(store: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const hit = store.get(key)
  if (!hit) return undefined
  if (hit.expires <= Date.now()) {
    store.delete(key)
    return undefined
  }
  return hit.value
}

function write<T>(store: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number): void {
  store.set(key, { value, expires: Date.now() + ttlMs })
  // The catalogue is large and long-tailed; without a bound this map is a slow
  // memory leak across every token anyone ever opens.
  if (store.size > MAX_CACHE_ENTRIES) {
    const oldest = store.keys().next().value
    if (oldest !== undefined) store.delete(oldest)
  }
}
