import { describe, expect, it } from 'vitest'
import { marketQuerySchema } from '../src/api/routes/markets.js'
import {
  balancesQuerySchema,
  ownershipChallengeInputSchema,
  ownershipProofInputSchema,
} from '../src/api/routes/portfolio.js'
import { valuationHistoryQuerySchema } from '../src/api/routes/phase12.js'
import { intentInputSchema, quoteInputSchema } from '../src/api/routes/trading.js'
import { transactionHistoryQuerySchema, transactionSubmissionSchema } from '../src/api/routes/transactions.js'

const id = '123e4567-e89b-42d3-a456-426614174000'

describe('public API request contracts', () => {
  it('accepts an exact executable quote request and applies the slippage default', () => {
    expect(
      quoteInputSchema.parse({
        marketId: 'ethereum:0x:WETH-USDC',
        side: 'buy',
        amountRaw: '1000000',
        sourceAccountId: id,
      }),
    ).toMatchObject({ amountRaw: '1000000', slippageBps: 50 })
  })

  it.each(['0', '-1', '1.5', 1000])('rejects non-positive-integer-string amountRaw %p', (amountRaw) => {
    expect(
      quoteInputSchema.safeParse({
        marketId: 'market',
        side: 'sell',
        amountRaw,
        sourceAccountId: id,
      }).success,
    ).toBe(false)
  })

  it('rejects unknown body fields on money-moving requests', () => {
    expect(
      intentInputSchema.safeParse({ quoteId: id, idempotencyKey: 'unique-key', userId: id }).success,
    ).toBe(false)
    expect(
      transactionSubmissionSchema.safeParse({
        signedTransaction: 'a'.repeat(20),
        intentId: id,
      }).success,
    ).toBe(false)
  })

  it('coerces and bounds pagination inputs', () => {
    expect(marketQuerySchema.parse({ limit: '25' }).limit).toBe(25)
    expect(transactionHistoryQuerySchema.parse({}).limit).toBe(50)
    expect(valuationHistoryQuerySchema.parse({}).limit).toBe(30)
    expect(marketQuerySchema.safeParse({ limit: '101' }).success).toBe(false)
  })

  it('rejects unrecognized query options', () => {
    expect(marketQuerySchema.safeParse({ sort: 'price' }).success).toBe(false)
    expect(balancesQuerySchema.safeParse({ refresh: 'yes' }).success).toBe(false)
    expect(transactionHistoryQuerySchema.safeParse({ page: '2' }).success).toBe(false)
  })

  it('requires ownership proof for account registration', () => {
    expect(ownershipChallengeInputSchema.parse({ networkId: 'ethereum-mainnet', address: '0xabc' })).toEqual({
      networkId: 'ethereum-mainnet',
      address: '0xabc',
    })
    expect(
      ownershipProofInputSchema.safeParse({
        networkId: 'ethereum-mainnet',
        address: '0xabc',
        label: 'proofless',
      }).success,
    ).toBe(false)
  })
})
