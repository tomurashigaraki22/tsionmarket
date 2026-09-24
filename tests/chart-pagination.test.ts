import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChartService } from '../src/markets/ChartService.js'
import { chartQuerySchema } from '../src/api/routes/markets.js'
import type { Environment } from '../src/config/env.js'

afterEach(() => vi.unstubAllGlobals())

describe('chart history', () => {
  it('validates the older-page cursor and source', () => {
    expect(
      chartQuerySchema.parse({
        networkId: 'solana-mainnet-beta',
        token: 'mint',
        before: '100',
        source: 'geckoterminal',
      }).before,
    ).toBe(100)
    expect(() =>
      chartQuerySchema.parse({ networkId: 'solana-mainnet-beta', token: 'mint', before: '-1' }),
    ).toThrow()
  })

  it('requests older GeckoTerminal bars from the same source without repeating the boundary candle', async () => {
    const requested: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input)
        requested.push(url)
        if (url.includes('/tokens/mint/pools'))
          return new Response(
            JSON.stringify({ data: [{ id: 'solana_pool', attributes: { reserve_in_usd: '1000' } }] }),
            { status: 200 },
          )
        if (url.includes('/ohlcv/')) {
          const older = url.includes('before_timestamp=99')
          return new Response(
            JSON.stringify({
              data: { attributes: { ohlcv_list: older ? [[90, 1, 1, 1, 1, 1]] : [[100, 2, 2, 2, 2, 1]] } },
            }),
            { status: 200 },
          )
        }
        return new Response(JSON.stringify({ data: { attributes: {} } }), { status: 200 })
      }),
    )
    const service = new ChartService({ BIRDEYE_API_KEY: '' } as Environment)
    const input = {
      networkId: 'solana-mainnet-beta',
      token: 'mint',
      interval: '1h',
      source: 'geckoterminal' as const,
    }
    const first = await service.candles(input)
    const second = await service.candles({ ...input, before: first.nextCursor! })
    expect(first.candles.map((bar) => bar.time)).toEqual([100])
    expect(second.candles.map((bar) => bar.time)).toEqual([90])
    expect(second.nextCursor).toBe(90)
    expect(requested.some((url) => url.includes('before_timestamp=99'))).toBe(true)
    expect(requested.some((url) => url.includes('birdeye'))).toBe(false)
  })

  it('continues from another ranked pool when the deepest pool is newly created', async () => {
    const requested: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input)
        requested.push(url)
        if (url.includes('/tokens/mint/pools'))
          return new Response(
            JSON.stringify({
              data: [
                { id: 'solana_deep', attributes: { reserve_in_usd: '1000' } },
                { id: 'solana_old', attributes: { reserve_in_usd: '900' } },
              ],
            }),
            { status: 200 },
          )
        if (url.includes('/pools/old/ohlcv/'))
          return new Response(
            JSON.stringify({
              data: { attributes: { ohlcv_list: [[90, 1, 1, 1, 1, 1]] } },
            }),
            { status: 200 },
          )
        if (url.includes('/ohlcv/'))
          return new Response(
            JSON.stringify({
              data: {
                attributes: {
                  ohlcv_list: url.includes('before_timestamp') ? [] : [[100, 2, 2, 2, 2, 1]],
                },
              },
            }),
            { status: 200 },
          )
        return new Response(JSON.stringify({ data: { attributes: {} } }), {
          status: 200,
        })
      }),
    )
    const service = new ChartService({ BIRDEYE_API_KEY: '' } as Environment)
    const input = {
      networkId: 'solana-mainnet-beta',
      token: 'mint',
      interval: '1h',
      source: 'geckoterminal' as const,
    }
    const first = await service.candles(input)
    const second = await service.candles({ ...input, before: first.nextCursor! })
    expect(first.candles.map((bar) => bar.time)).toEqual([100])
    expect(second.candles.map((bar) => bar.time)).toEqual([90])
    expect(requested.some((url) => url.includes('/pools/old/ohlcv/'))).toBe(true)
  })
})
