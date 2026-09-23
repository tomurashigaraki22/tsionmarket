/**
 * The pure parts of the chart source — pool choice and candle normalisation.
 *
 * Kept out of the service so they can be tested without a request: both are
 * places a wrong answer is silent rather than loud. Charting a thin pool draws
 * real-looking candles nobody could have traded, and an out-of-order or
 * duplicated timestamp makes the charting library throw mid-render.
 */

export type Candle = {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export type ChartSource = 'birdeye' | 'geckoterminal' | 'coingecko'

export type ChartStats = {
  price: number | null
  changePct24h: number | null
  volume24h: number | null
}

export type ChartPayload = {
  candles: Array<Candle>
  stats: ChartStats | null
  source: ChartSource | null
  /** Intervals this token can actually be drawn at, given the source that answered. */
  intervals: Array<string>
}

/** Bar length in seconds for each interval the chart offers. */
export const INTERVAL_SECONDS: Record<string, number> = {
  '1m': 60,
  '5m': 5 * 60,
  '15m': 15 * 60,
  '1h': 60 * 60,
  '4h': 4 * 60 * 60,
  '1d': 24 * 60 * 60,
}

export function num(value: unknown): number | null {
  const parsed =
    typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN
  return Number.isFinite(parsed) ? parsed : null
}

type PoolRow = { id?: string; attributes?: { address?: string; reserve_in_usd?: string | number } }

/**
 * The pool to chart: the deepest one. A token trades in many pools and thin
 * ones print noise — a $200 pool shows a 60% candle against a few dollars of
 * flow. Depth is also the pool an order actually routes through. The upstream
 * does not return these sorted, so this must sort.
 */
export function pickBestPool(rows: ReadonlyArray<PoolRow> | undefined): string | null {
  const best = (rows ?? [])
    .map((row) => ({
      // `id` is '<chain>_<address>'; prefer the explicit attribute where given.
      address:
        row.attributes?.address ??
        String(row.id ?? '')
          .split('_')
          .slice(1)
          .join('_'),
      liquidity: num(row.attributes?.reserve_in_usd) ?? 0,
    }))
    .filter((row) => row.address)
    .sort((a, b) => b.liquidity - a.liquidity)[0]
  return best?.address ?? null
}

function ascendingDistinct(candles: Array<Candle>): Array<Candle> {
  return candles
    .filter(
      (candle) =>
        Number.isFinite(candle.time) &&
        Number.isFinite(candle.open) &&
        Number.isFinite(candle.high) &&
        Number.isFinite(candle.low) &&
        Number.isFinite(candle.close),
    )
    // Upstreams return newest-first; the chart requires strictly ascending
    // time and throws on a duplicate timestamp.
    .sort((a, b) => a.time - b.time)
    .filter((candle, index, all) => index === 0 || candle.time !== all[index - 1]?.time)
}

/** `[time, open, high, low, close, volume]` rows → candles the chart can take. */
export function normalizeOhlcv(rows: ReadonlyArray<ReadonlyArray<number | string>> | undefined) {
  return ascendingDistinct(
    (rows ?? []).map((row) => ({
      time: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]) || 0,
    })),
  )
}

/**
 * Birdeye's `defi/ohlcv` items → candles. `vUsd` is the dollar volume and the
 * one worth plotting; some chains return only the token-denominated `v`, and a
 * bar with neither reports zero rather than a guess.
 */
export function normalizeBirdeye(items: ReadonlyArray<Record<string, unknown>> | undefined) {
  return ascendingDistinct(
    (items ?? []).map((item) => ({
      time: Number(item.unixTime),
      open: Number(item.o),
      high: Number(item.h),
      low: Number(item.l),
      close: Number(item.c),
      volume: Number(item.vUsd ?? item.v) || 0,
    })),
  )
}

/**
 * Last price and 24h change, derived from the candles themselves.
 *
 * The pool endpoint reports a change for its BASE token, but our token is the
 * quote in roughly half of these pairs — a USDC/TOKEN pool as easily as a
 * TOKEN/SOL one — so reading it directly can pick the wrong side. The series
 * is already priced in our token because the OHLCV request names it.
 *
 * The change is null unless the series actually spans 24 hours: a 1m chart
 * holds about sixteen, and labelling a sixteen-hour move '24h' would be wrong.
 */
export function stats24hFrom(candles: ReadonlyArray<Candle>): {
  price: number | null
  changePct24h: number | null
} {
  const last = candles.at(-1)
  if (!last || !candles[0]) return { price: null, changePct24h: null }
  const cutoff = last.time - 24 * 60 * 60
  if (candles[0].time > cutoff) return { price: last.close, changePct24h: null }

  const reference = candles.find((candle) => candle.time >= cutoff) ?? candles[0]
  const base = reference.open || reference.close
  if (!base) return { price: last.close, changePct24h: null }
  return { price: last.close, changePct24h: ((last.close - base) / base) * 100 }
}

/**
 * Price samples → candles, bucketed to an exact interval.
 *
 * The pool sources serve real OHLC. CoinGecko serves a price SERIES — sampled
 * points, not trades — so bars are derived here: open is the first sample in
 * the bucket, close the last, high and low the extremes of what was sampled.
 * That is an honest summary of the samples and nothing more, which is why a
 * chart drawn this way reports its source. Volume is not derivable from a
 * price series and stays zero rather than being invented.
 */
export function bucketPrices(
  points: ReadonlyArray<ReadonlyArray<number>> | undefined,
  intervalSeconds: number,
): Array<Candle> {
  if (!points?.length || intervalSeconds <= 0) return []
  const buckets = new Map<number, Candle>()

  for (const point of points) {
    const ms = Number(point[0])
    const price = Number(point[1])
    if (!Number.isFinite(ms) || !Number.isFinite(price)) continue
    const time = Math.floor(Math.floor(ms / 1000) / intervalSeconds) * intervalSeconds
    const existing = buckets.get(time)
    if (!existing) {
      buckets.set(time, { time, open: price, high: price, low: price, close: price, volume: 0 })
      continue
    }
    // Samples arrive in order, so the last one seen closes the bar.
    existing.high = Math.max(existing.high, price)
    existing.low = Math.min(existing.low, price)
    existing.close = price
  }

  return [...buckets.values()].sort((a, b) => a.time - b.time)
}
