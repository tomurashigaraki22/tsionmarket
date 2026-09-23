/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unnecessary-type-assertion -- LI.FI JSON is checked and normalized before returning */
import type { Environment } from '../config/env.js'
import { AppError } from '../utils/errors.js'
import type { LifiQuote, OwnedAccount } from './types.js'

const chains: Record<string, string> = {
  'ethereum-mainnet': 'ETH',
  'arbitrum-one': 'ARB',
  'solana-mainnet-beta': 'SOL',
}
const native: Record<string, Set<string>> = {
  'ethereum-mainnet': new Set(
    ['0x0000000000000000000000000000000000000000', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'].map((v) =>
      v.toLowerCase(),
    ),
  ),
  'arbitrum-one': new Set(
    ['0x0000000000000000000000000000000000000000', '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'].map((v) =>
      v.toLowerCase(),
    ),
  ),
  'solana-mainnet-beta': new Set(['So11111111111111111111111111111111111111112']),
}
function token(networkId: string, value: string) {
  if (native[networkId]?.has(networkId.startsWith('solana') ? value : value.toLowerCase()))
    return networkId.startsWith('solana') ? 'SOL' : '0x0000000000000000000000000000000000000000'
  return value
}

export class LifiProvider {
  constructor(private env: Environment) {}
  async quote(input: {
    source: OwnedAccount
    destination: OwnedAccount
    sellToken: string
    buyToken: string
    sellAmountRaw: string
    slippageBps: number
  }): Promise<LifiQuote> {
    const fromChain = chains[input.source.networkId],
      toChain = chains[input.destination.networkId]
    if (!fromChain || !toChain)
      throw new AppError('ROUTE_UNAVAILABLE', 'LI.FI is unavailable for this route', 409)
    const url = new URL(`${this.env.LIFI_API_URL}/quote`)
    url.searchParams.set('fromChain', fromChain)
    url.searchParams.set('toChain', toChain)
    url.searchParams.set('fromToken', token(input.source.networkId, input.sellToken))
    url.searchParams.set('toToken', token(input.destination.networkId, input.buyToken))
    url.searchParams.set('fromAmount', input.sellAmountRaw)
    url.searchParams.set('fromAddress', input.source.address)
    url.searchParams.set('toAddress', input.destination.address)
    url.searchParams.set('slippage', String(input.slippageBps / 10_000))
    url.searchParams.set('integrator', this.env.LIFI_INTEGRATOR)
    if (input.source.networkId === input.destination.networkId)
      url.searchParams.set('allowSwitchChain', 'false')
    const headers: Record<string, string> = { accept: 'application/json' }
    if (this.env.LIFI_API_KEY) headers['x-lifi-api-key'] = this.env.LIFI_API_KEY
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(this.env.LIFI_QUOTE_TIMEOUT_MS),
    })
    const body = (await response.json().catch(() => ({}))) as any
    const tx = body.transactionRequest as Record<string, unknown> | undefined,
      toAmount = body.estimate?.toAmount,
      toAmountMin = body.estimate?.toAmountMin ?? toAmount,
      fromAmount = body.estimate?.fromAmount ?? input.sellAmountRaw
    if (!response.ok || !tx || typeof toAmount !== 'string' || typeof toAmountMin !== 'string')
      throw new AppError(
        'SPOT_QUOTE_FAILED',
        String(body.message ?? body.error ?? `LI.FI returned HTTP ${response.status}`),
        502,
      )
    if (String(fromAmount) !== input.sellAmountRaw)
      throw new AppError('PROVIDER_QUOTE_INVALID', 'LI.FI changed the requested source amount', 502)
    return {
      tool: String(body.tool ?? 'LI.FI'),
      fromAmount: String(fromAmount),
      toAmount,
      toAmountMin,
      approvalAddress:
        typeof body.estimate?.approvalAddress === 'string' ? body.estimate.approvalAddress : null,
      priceImpactBps: Number.isFinite(Number(body.estimate?.data?.priceImpact))
        ? Math.round(Number(body.estimate.data.priceImpact) * 10_000)
        : null,
      estimatedFeeRaw:
        typeof body.estimate?.gasCosts?.[0]?.amount === 'string' ? body.estimate.gasCosts[0].amount : null,
      transactionRequest: tx,
      snapshot: body as Record<string, unknown>,
    }
  }
}
