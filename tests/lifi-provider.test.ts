import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseEnvironment } from '../src/config/env.js'
import { LifiProvider } from '../src/trading/LifiProvider.js'

const environment = parseEnvironment({
  MYSQL_HOST: 'localhost',
  MYSQL_DATABASE: 'test',
  MYSQL_USER: 'test',
  MYSQL_PASSWORD: 'test',
  MYSQL_MIGRATION_USER: 'migrator',
  MYSQL_MIGRATION_PASSWORD: 'test',
  LIFI_INTEGRATOR: 'tewa',
})
const evm = {
  id: 'a',
  networkId: 'ethereum-mainnet',
  address: '0x1111111111111111111111111111111111111111',
  family: 'evm' as const,
  chainId: 1,
}

describe('LI.FI provider', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('attributes quotes to the tewa Portal integrator and maps wrapped ETH to native ETH', async () => {
    let requested: URL | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        requested = new URL(String(input))
        return new Response(
          JSON.stringify({
            tool: '1inch',
            estimate: {
              fromAmount: '100',
              toAmount: '90',
              toAmountMin: '88',
              approvalAddress: '0x2222222222222222222222222222222222222222',
            },
            transactionRequest: { to: '0x3333333333333333333333333333333333333333', data: '0x12' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }),
    )
    const result = await new LifiProvider(environment).quote({
      source: evm,
      destination: evm,
      sellToken: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      buyToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      sellAmountRaw: '100',
      slippageBps: 50,
    })
    expect(requested?.searchParams.get('integrator')).toBe('tewa')
    expect(requested?.searchParams.get('fromToken')).toBe('0x0000000000000000000000000000000000000000')
    expect(requested?.searchParams.get('allowSwitchChain')).toBe('false')
    expect(result).toMatchObject({ fromAmount: '100', toAmount: '90', toAmountMin: '88' })
  })
  it('rejects a provider response that mutates the requested input amount', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              estimate: { fromAmount: '101', toAmount: '90' },
              transactionRequest: { data: '0x12' },
            }),
            { status: 200 },
          ),
      ),
    )
    await expect(
      new LifiProvider(environment).quote({
        source: evm,
        destination: evm,
        sellToken: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        buyToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        sellAmountRaw: '100',
        slippageBps: 50,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_QUOTE_INVALID' })
  })
})
