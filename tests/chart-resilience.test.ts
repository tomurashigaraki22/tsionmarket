import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChartService } from '../src/markets/ChartService.js'
import type { Environment } from '../src/config/env.js'

const env = { BIRDEYE_API_KEY: '' } as Environment
const input = {
  networkId: 'solana-mainnet-beta',
  token: 'mint',
  interval: '1h',
  source: 'geckoterminal' as const,
}

type Mode = 'ok' | 'limited' | 'unlisted'

function stubGecko(state: { mode: Mode }, seen: string[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: string | URL) => {
      const url = String(request)
      seen.push(url)
      if (state.mode === 'limited')
        return new Response('slow down', { status: 429, headers: { 'retry-after': '30' } })
      if (url.includes('/tokens/mint/pools')) {
        if (state.mode === 'unlisted') return new Response('{}', { status: 404 })
        return new Response(
          JSON.stringify({ data: [{ id: 'solana_pool', attributes: { reserve_in_usd: '1000' } }] }),
          { status: 200 },
        )
      }
      if (url.includes('/ohlcv/'))
        return new Response(
          JSON.stringify({ data: { attributes: { ohlcv_list: [[100, 2, 3, 1, 2, 5]] } } }),
          { status: 200 },
        )
      return new Response(JSON.stringify({ data: { attributes: { volume_usd: { h24: '1234' } } } }), {
        status: 200,
      })
    }),
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-07T00:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('chart when the provider rate-limits us', () => {
  it('says the sources failed instead of claiming the token has no chart', async () => {
    stubGecko({ mode: 'limited' })
    const payload = await new ChartService(env, { geckoSpacingMs: 0 }).candles(input)
    expect(payload.candles).toHaveLength(0)
    expect(payload.degraded).toBe(true)
  })

  it('asks again within seconds rather than remembering the miss as "unlisted"', async () => {
    const state = { mode: 'limited' as Mode }
    stubGecko(state)
    const service = new ChartService(env, { geckoSpacingMs: 0 })
    await service.candles(input)

    state.mode = 'ok'
    // Past the short miss TTL and the provider's cool-down.
    vi.setSystemTime(Date.now() + 60_000)
    const payload = await service.candles(input)
    expect(payload.candles).toHaveLength(1)
    expect(payload.degraded).toBeUndefined()
  })

  it('keeps showing the last good chart while every source is failing', async () => {
    const state = { mode: 'ok' as Mode }
    stubGecko(state)
    const service = new ChartService(env, { geckoSpacingMs: 0 })
    const good = await service.candles(input)
    expect(good.candles).toHaveLength(1)

    state.mode = 'limited'
    vi.setSystemTime(Date.now() + 5 * 60_000)
    const during = await service.candles(input)
    expect(during.candles).toHaveLength(1)
    expect(during.degraded).toBeUndefined()
  })

  it('treats a genuine 404 as no chart, not as a failure', async () => {
    stubGecko({ mode: 'unlisted' })
    const payload = await new ChartService(env, { geckoSpacingMs: 0 }).candles(input)
    expect(payload.candles).toHaveLength(0)
    expect(payload.degraded).toBeUndefined()
  })
})

describe('provider call budget', () => {
  it('reads a pool’s volume once, not on every interval', async () => {
    const seen: string[] = []
    stubGecko({ mode: 'ok' }, seen)
    const service = new ChartService(env, { geckoSpacingMs: 0 })
    await service.candles(input)
    await service.candles({ ...input, interval: '15m' })
    await service.candles({ ...input, interval: '5m' })

    const detail = seen.filter((url) => url.endsWith('/pools/pool'))
    expect(detail).toHaveLength(1)
  })

  it('spaces calls out so a burst does not trip the limit', async () => {
    const seen: number[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (request: string | URL) => {
        seen.push(Date.now())
        const url = String(request)
        if (url.includes('/tokens/mint/pools'))
          return new Response(JSON.stringify({ data: [{ id: 'solana_pool', attributes: {} }] }), {
            status: 200,
          })
        return new Response(
          JSON.stringify({
            data: { attributes: { ohlcv_list: [[100, 2, 3, 1, 2, 5]], volume_usd: { h24: '1' } } },
          }),
          { status: 200 },
        )
      }),
    )
    const run = new ChartService(env, { geckoSpacingMs: 2_000 }).candles(input)
    await vi.advanceTimersByTimeAsync(10_000)
    await run
    const gaps = seen.slice(1).map((time, i) => time - seen[i]!)
    expect(gaps.every((gap) => gap >= 2_000)).toBe(true)
  })
})
