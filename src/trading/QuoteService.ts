import { AppError } from '../utils/errors.js'
import type { Environment } from '../config/env.js'
import type { LifiProvider } from './LifiProvider.js'
import type { TradingRepository } from './TradingRepository.js'

export class QuoteService {
  constructor(
    private repo: TradingRepository,
    private provider: LifiProvider,
    private env: Environment,
  ) {}
  async create(
    userId: string,
    input: {
      marketId: string
      side: 'buy' | 'sell'
      amountRaw: string
      sourceAccountId: string
      slippageBps: number
    },
  ) {
    const market = await this.repo.market(input.marketId)
    if (!market || !market.active) throw new AppError('MARKET_UNAVAILABLE', 'Market is unavailable', 404)
    const source = await this.repo.account(userId, input.sourceAccountId)
    if (!source || source.networkId !== market.networkId)
      throw new AppError('ACCOUNT_NOT_READY', 'An active account on the market network is required', 409)
    if (input.slippageBps > this.env.MAX_SLIPPAGE_BPS)
      throw new AppError('SLIPPAGE_TOO_HIGH', 'Requested slippage exceeds policy', 400)
    const sellToken = input.side === 'buy' ? String(market.quoteToken) : String(market.baseToken),
      buyToken = input.side === 'buy' ? String(market.baseToken) : String(market.quoteToken),
      sellDecimals = input.side === 'buy' ? 6 : Number(market.decimals),
      buyDecimals = input.side === 'buy' ? Number(market.decimals) : 6
    const quote = await this.provider.quote({
      source,
      destination: source,
      sellToken,
      buyToken,
      sellAmountRaw: input.amountRaw,
      slippageBps: input.slippageBps,
    })
    if (quote.priceImpactBps !== null && Math.abs(quote.priceImpactBps) > this.env.MAX_SLIPPAGE_BPS)
      throw new AppError('SLIPPAGE_TOO_HIGH', 'Provider price impact exceeds policy', 409)
    const stored = await this.repo.createQuote({
      userId,
      source,
      destination: source,
      marketId: input.marketId,
      sellToken,
      buyToken,
      sellAmountRaw: input.amountRaw,
      sellDecimals,
      buyDecimals,
      slippageBps: input.slippageBps,
      quote,
      integrator: this.env.LIFI_INTEGRATOR,
      ttl: this.env.SWAP_QUOTE_TTL_SECONDS,
    })
    return {
      quoteId: stored.id,
      provider: 'lifi',
      integrator: this.env.LIFI_INTEGRATOR,
      sourceNetworkId: source.networkId,
      destinationNetworkId: source.networkId,
      sellToken,
      buyToken,
      sellAmountRaw: input.amountRaw,
      buyAmountRaw: quote.toAmount,
      minimumBuyAmountRaw: quote.toAmountMin,
      sellDecimals,
      buyDecimals,
      priceImpactBps: quote.priceImpactBps,
      estimatedFeeRaw: quote.estimatedFeeRaw,
      tool: quote.tool,
      executable: true,
      expiresAt: stored.expiresAt.toISOString(),
    }
  }
}
