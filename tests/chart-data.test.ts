import { describe, expect, it } from 'vitest'
import {
  bucketPrices,
  normalizeBirdeye,
  normalizeOhlcv,
  pickBestPool,
  stats24hFrom,
} from '../src/markets/chartData.js'

const HOUR = 60 * 60

describe('pickBestPool', () => {
  it('picks the deepest pool, not the first one returned', () => {
    expect(
      pickBestPool([
        { id: 'solana_thin', attributes: { reserve_in_usd: '200' } },
        { id: 'solana_deep', attributes: { reserve_in_usd: '4000000' } },
      ]),
    ).toBe('deep')
  })

  it('prefers the explicit address attribute over the composite id', () => {
    expect(
      pickBestPool([{ id: 'eth_0xwrong', attributes: { address: '0xright', reserve_in_usd: '1' } }]),
    ).toBe('0xright')
  })

  it('returns null when nothing usable came back', () => {
    expect(pickBestPool([])).toBeNull()
    expect(pickBestPool(undefined)).toBeNull()
  })
})

describe('normalizeOhlcv', () => {
  it('sorts ascending and drops duplicate timestamps', () => {
    // The chart library throws on unordered or repeated times, and upstreams
    // return newest-first.
    const candles = normalizeOhlcv([
      [200, 2, 3, 1, 2, 10],
      [100, 1, 2, 1, 1, 5],
      [200, 9, 9, 9, 9, 9],
    ])
    expect(candles.map((candle) => candle.time)).toEqual([100, 200])
  })

  it('discards rows that cannot be parsed', () => {
    expect(normalizeOhlcv([['bad', 1, 2, 3, 4, 5]])).toEqual([])
  })
})

describe('normalizeBirdeye', () => {
  it('prefers dollar volume over token volume', () => {
    const [candle] = normalizeBirdeye([
      { unixTime: 1, o: 1, h: 2, l: 0.5, c: 1.5, v: 999, vUsd: 42 },
    ])
    expect(candle?.volume).toBe(42)
  })

  it('reports zero rather than guessing when neither volume is present', () => {
    const [candle] = normalizeBirdeye([{ unixTime: 1, o: 1, h: 2, l: 0.5, c: 1.5 }])
    expect(candle?.volume).toBe(0)
  })
})

describe('stats24hFrom', () => {
  it('withholds the 24h change when the series is shorter than 24h', () => {
    // A 1m chart holds about sixteen hours; calling that move "24h" is wrong.
    const candles = [
      { time: 0, open: 10, high: 10, low: 10, close: 10, volume: 0 },
      { time: HOUR, open: 20, high: 20, low: 20, close: 20, volume: 0 },
    ]
    expect(stats24hFrom(candles)).toEqual({ price: 20, changePct24h: null })
  })

  it('measures the change against the first bar at or after the cutoff', () => {
    const candles = [
      { time: 0, open: 50, high: 50, low: 50, close: 50, volume: 0 },
      { time: 25 * HOUR, open: 100, high: 100, low: 100, close: 100, volume: 0 },
      { time: 49 * HOUR, open: 150, high: 150, low: 150, close: 150, volume: 0 },
    ]
    expect(stats24hFrom(candles)).toEqual({ price: 150, changePct24h: 50 })
  })

  it('has nothing to report for an empty series', () => {
    expect(stats24hFrom([])).toEqual({ price: null, changePct24h: null })
  })
})

describe('bucketPrices', () => {
  it('summarises samples into one bar per interval', () => {
    const candles = bucketPrices(
      [
        [0, 10],
        [30_000, 15],
        [59_000, 12],
        [60_000, 20],
      ],
      60,
    )
    expect(candles).toEqual([
      { time: 0, open: 10, high: 15, low: 10, close: 12, volume: 0 },
      { time: 60, open: 20, high: 20, low: 20, close: 20, volume: 0 },
    ])
  })

  it('leaves volume at zero, since a price series does not carry it', () => {
    expect(bucketPrices([[0, 1]], 60).every((candle) => candle.volume === 0)).toBe(true)
  })

  it('returns nothing for empty input', () => {
    expect(bucketPrices(undefined, 60)).toEqual([])
    expect(bucketPrices([[0, 1]], 0)).toEqual([])
  })
})
