export type OwnedAccount = {
  id: string
  networkId: string
  address: string
  family: 'evm' | 'solana' | 'intertrain'
  chainId: number | null
}
export type QuoteRecord = {
  id: string
  userId: string
  sourceAccountId: string
  destinationAccountId: string
  sourceNetworkId: string
  destinationNetworkId: string
  sellToken: string
  buyToken: string
  sellAmountRaw: string
  buyAmountRaw: string
  minimumBuyAmountRaw: string
  sellDecimals: number
  buyDecimals: number
  slippageBps: number
  approvalAddress: string | null
  providerSnapshot: Record<string, unknown>
  expiresAt: Date
  consumedAt: Date | null
}
export type LifiQuote = {
  tool: string
  fromAmount: string
  toAmount: string
  toAmountMin: string
  approvalAddress: string | null
  priceImpactBps: number | null
  estimatedFeeRaw: string | null
  transactionRequest: Record<string, unknown>
  snapshot: Record<string, unknown>
}
