import { describe, expect, it, vi } from 'vitest'
import { QuoteService } from '../src/trading/QuoteService.js'

const paymentId = '123e4567-e89b-42d3-a456-426614174001'

function setup(payment: unknown) {
  const repo = {
    market: vi.fn().mockResolvedValue({
      marketId: 'SOL/USDC',
      networkId: 'arbitrum-one',
      baseToken: '0xsol',
      quoteToken: '0xusdc',
      baseSymbol: 'SOL',
      quoteSymbol: 'USDC',
      decimals: 9,
      active: true,
    }),
    account: vi.fn().mockResolvedValue({
      id: 'account-1',
      networkId: 'arbitrum-one',
      address: '0xwallet',
      family: 'evm',
      chainId: 42161,
    }),
    completedOnrampPayment: vi.fn().mockResolvedValue(payment),
    createQuote: vi.fn().mockResolvedValue({ id: 'quote-1', expiresAt: new Date('2026-09-25T00:01:00Z') }),
  }
  const provider = {
    quote: vi.fn().mockResolvedValue({
      tool: 'test-router',
      toAmount: '2000000',
      toAmountMin: '1900000',
      approvalAddress: null,
      priceImpactBps: 10,
      estimatedFeeRaw: null,
      snapshot: { transactionRequest: {} },
    }),
  }
  const environment = {
    MAX_SLIPPAGE_BPS: 500,
    LIFI_INTEGRATOR: 'tsionmarket',
    SWAP_QUOTE_TTL_SECONDS: 60,
  }
  return {
    service: new QuoteService(repo as never, provider as never, environment as never),
    repo,
    provider,
  }
}

const input = {
  marketId: 'SOL/USDC',
  side: 'buy' as const,
  amountRaw: '1000000',
  sourceAccountId: 'account-1',
  sourcePaymentId: paymentId,
  slippageBps: 100,
}

describe('spot quote context from a fiat on-ramp', () => {
  it('rejects a payment that is not a completed on-ramp for the selected wallet', async () => {
    const { service, provider } = setup(null)

    await expect(service.create('user-1', input)).rejects.toMatchObject({
      code: 'PAYMENT_SWAP_NOT_READY',
    })
    expect(provider.quote).not.toHaveBeenCalled()
  })

  it('does not let the payment context be reused for another token or network', async () => {
    const { service, provider } = setup({
      id: paymentId,
      accountId: 'account-1',
      networkId: 'arbitrum-one',
      assetKey: 'arbitrum-one:usdt',
      assetAddress: '0xusdt',
      assetSymbol: 'USDT',
    })

    await expect(service.create('user-1', input)).rejects.toMatchObject({
      code: 'PAYMENT_SWAP_NOT_READY',
    })
    expect(provider.quote).not.toHaveBeenCalled()
  })

  it('stores the payment link only for a matching completed stablecoin buy quote', async () => {
    const { service, repo } = setup({
      id: paymentId,
      accountId: 'account-1',
      networkId: 'arbitrum-one',
      assetKey: 'arbitrum-one:usdc',
      assetAddress: '0xUSDC',
      assetSymbol: 'USDC',
    })

    const result = await service.create('user-1', input)

    expect(repo.createQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePaymentOperationId: paymentId,
      }),
    )
    expect(result.sourcePaymentId).toBe(paymentId)
  })

  it('rejects using an on-ramp link for a sell-side quote', async () => {
    const { service, repo } = setup(null)

    await expect(service.create('user-1', { ...input, side: 'sell' })).rejects.toMatchObject({
      code: 'PAYMENT_SWAP_ASSET_MISMATCH',
    })
    expect(repo.completedOnrampPayment).not.toHaveBeenCalled()
  })
})
