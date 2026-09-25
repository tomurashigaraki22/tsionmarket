import { describe, expect, it, vi } from 'vitest'
import { parseEnvironment } from '../src/config/env.js'
import { OnSwitchPaymentFlowService, paymentQuoteInputSchema } from '../src/payments/onswitch/journeys.js'
import { OnSwitchPaymentsService } from '../src/payments/onswitch/service.js'
import type { OnSwitchClient } from '../src/payments/onswitch/client.js'
import type { OnSwitchCatalogueService } from '../src/payments/onswitch/catalogue.js'
import type { OnSwitchPaymentRepository } from '../src/payments/onswitch/repository.js'
import type { TradingRepository } from '../src/trading/TradingRepository.js'
import type { WithdrawalIntentService } from '../src/trading/WithdrawalIntentService.js'

const environment = parseEnvironment({
  NODE_ENV: 'test',
  MYSQL_HOST: 'localhost',
  MYSQL_DATABASE: 'payments_test',
  MYSQL_USER: 'app',
  MYSQL_PASSWORD: 'password',
  MYSQL_MIGRATION_USER: 'migration',
  MYSQL_MIGRATION_PASSWORD: 'password',
  ONSWITCH_ENABLED: 'true',
  ONSWITCH_ENVIRONMENT: 'sandbox',
  ONSWITCH_SANDBOX_SERVICE_KEY: 'sandbox-secret-not-real',
  ONSWITCH_IDEMPOTENCY_SECRET: 'idempotency-secret-with-at-least-32-chars',
})

describe('OnSwitch payment journeys', () => {
  it('rejects a client-selected destination address in quote input', () => {
    expect(
      paymentQuoteInputSchema.safeParse({
        accountId: 'e6ef587e-d03d-44d0-a07a-a7e8a7aaabc1',
        amount: '25.00',
        country: 'NG',
        currency: 'NGN',
        channel: 'BANK',
        assetKey: 'arbitrum-one:usdc',
        wallet: '0x0000000000000000000000000000000000000001',
      }).success,
    ).toBe(false)
  })

  it('quotes and initiates an on-ramp only to the selected verified account', async () => {
    const userId = 'ca2495a0-0172-46a0-a2e2-0b0e513f8d10'
    const quoteId = 'e6ef587e-d03d-44d0-a07a-a7e8a7aaabc1'
    const operationId = '69e8e664-b9fe-a9f9-e6dc-3cbb00000000'
    const account = {
      id: '5fe4d3d5-1e43-44d3-93ed-f5d21d4f3596',
      networkId: 'arbitrum-one',
      family: 'evm' as const,
      chainId: 42161,
      address: '0x0000000000000000000000000000000000000001',
    }
    let quoteTerms: unknown
    let payment: Record<string, unknown> | null = null
    const expiresAt = new Date(Date.now() + 60_000)
    const providerQuote = {
      rate: 1500.5,
      expiry: new Date(Date.now() + 10 * 60_000).toISOString(),
      settlement: 'Instant',
      channel: 'BANK',
      fee: { total: 5, platform: 4.5, developer: 0.5, currency: 'NGN' },
      fee_inclusive: true,
      source: { amount: 1500, currency: 'NGN' },
      destination: { amount: 1, currency: 'USDC' },
    }
    const client = {
      post: vi.fn(async (path: string, body: Record<string, unknown>) => {
        if (path === '/onramp/quote') return { success: true, data: providerQuote }
        return {
          success: true,
          data: {
            status: 'AWAITING_DEPOSIT',
            type: 'ONRAMP',
            reference: body.reference,
            rate: 1500.5,
            source: { amount: 1500, currency: 'NGN' },
            destination: { amount: 1, currency: 'USDC' },
            deposit: {
              amount: 1500,
              asset: 'arbitrum:usdc',
              account_number: '0123456789',
              account_name: 'Tsion Pay-in',
              bank_code: '090286',
              bank_name: 'Provider Bank',
              expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
              note: ['Send the exact amount.'],
            },
          },
        }
      }),
    } as unknown as OnSwitchClient
    const repository = {
      createQuote: vi.fn(async (input: { termsSnapshot: unknown }) => {
        quoteTerms = input.termsSnapshot
        return quoteId
      }),
      getQuoteForUser: vi.fn(async (requestedUser: string, requestedId: string) =>
        requestedUser === userId && requestedId === quoteId
          ? { id: quoteId, operationType: 'onramp', terms: quoteTerms, expiresAt, consumedAt: null }
          : null,
      ),
      findOperationByIdempotency: vi.fn(async () => null),
      createOperation: vi.fn(async () => ({ id: operationId, existing: false })),
      beginInitiation: vi.fn(async () => true),
      completeInitiation: vi.fn(
        async (input: { providerStatus: string; instructions: unknown; terms: unknown }) => {
          payment = {
            id: operationId,
            operationType: 'onramp',
            status: 'awaiting_fiat',
            providerReference: operationId,
            accountId: account.id,
            networkId: account.networkId,
            terms: input.terms,
            instructions: input.instructions,
            expiresAt: new Date(Date.now() + 30 * 60_000),
          }
        },
      ),
      getForUser: vi.fn(async () => payment),
    } as unknown as OnSwitchPaymentRepository
    const catalogue = {
      requirements: vi.fn(async () => ({ data: [] })),
      requireAvailableSelection: vi.fn(async () => ({
        capabilities: { verifiedNetworks: ['arbitrum-one'] },
        asset: {
          assetKey: 'arbitrum-one:usdc',
          networkId: 'arbitrum-one',
          symbol: 'USDC',
          decimals: 6,
          address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
          onrampAvailable: true,
          offrampAvailable: true,
        },
      })),
    } as unknown as OnSwitchCatalogueService
    const trading = { account: vi.fn(async () => account) } as unknown as TradingRepository
    const withdrawals = {} as WithdrawalIntentService
    const payments = new OnSwitchPaymentsService(repository, environment)
    const flow = new OnSwitchPaymentFlowService(
      client,
      catalogue,
      repository,
      payments,
      trading,
      withdrawals,
      environment,
    )

    const quote = await flow.quote(userId, 'onramp', {
      accountId: account.id,
      amount: '1500.00',
      country: 'NG',
      currency: 'NGN',
      channel: 'BANK',
      assetKey: 'arbitrum-one:usdc',
    })
    expect(quote.id).toBe(quoteId)
    expect(quote.source).toEqual({ amount: '1500', currency: 'NGN' })

    const result = await flow.initiateOnramp(userId, quoteId, {
      idempotencyKey: 'onswitch-onramp-key-0001',
      holderType: 'INDIVIDUAL',
      holderName: 'Test User',
    })
    expect(result.existing).toBe(false)
    expect(client.post).toHaveBeenCalledWith(
      '/onramp/initiate',
      expect.objectContaining({
        reference: operationId,
        beneficiary: {
          holder_type: 'INDIVIDUAL',
          holder_name: 'Test User',
          wallet_address: account.address,
        },
      }),
    )
    expect(result.payment).toMatchObject({ status: 'awaiting_fiat', providerReference: operationId })
    expect(JSON.stringify(result.payment)).toContain('accountNumber')
  })

  it('binds off-ramp transfer intents to the persisted provider amount, asset, and address', async () => {
    const userId = 'ca2495a0-0172-46a0-a2e2-0b0e513f8d10'
    const quoteId = 'e6ef587e-d03d-44d0-a07a-a7e8a7aaabc1'
    const operationId = '69e8e664-b9fe-a9f9-e6dc-3cbb00000000'
    const intentId = '8f82e3fe-a881-4182-8af0-7cb36d9dd858'
    const account = {
      id: '5fe4d3d5-1e43-44d3-93ed-f5d21d4f3596',
      networkId: 'arbitrum-one',
      family: 'evm' as const,
      chainId: 42161,
      address: '0x0000000000000000000000000000000000000001',
    }
    const providerDepositAddress = '0x0000000000000000000000000000000000000002'
    let quoteTerms: unknown
    let payment: Record<string, unknown> | null = null
    const expiresAt = new Date(Date.now() + 60_000)
    const providerQuote = {
      rate: 1500,
      expiry: new Date(Date.now() + 10 * 60_000).toISOString(),
      settlement: 'Same day',
      channel: 'BANK',
      fee: { total: 0.01, currency: 'USDC' },
      fee_inclusive: true,
      source: { amount: 1.25, currency: 'USDC' },
      destination: { amount: 1875, currency: 'NGN' },
    }
    const client = {
      post: vi.fn(async (path: string, body: Record<string, unknown>) => {
        if (path === '/offramp/quote') return { success: true, data: providerQuote }
        return {
          success: true,
          data: {
            status: 'AWAITING_DEPOSIT',
            type: 'OFFRAMP',
            reference: body.reference,
            rate: 1500,
            source: { amount: 1.25, currency: 'USDC' },
            destination: { amount: 1875, currency: 'NGN' },
            created_at: new Date().toISOString(),
            deposit: {
              amount: '1.25',
              asset: 'arbitrum:usdc',
              address: providerDepositAddress,
              note: ['This one-time address has a 30 minutes expiry window.'],
            },
          },
        }
      }),
    } as unknown as OnSwitchClient
    const repository = {
      createQuote: vi.fn(async (input: { termsSnapshot: unknown }) => {
        quoteTerms = input.termsSnapshot
        return quoteId
      }),
      getQuoteForUser: vi.fn(async () => ({
        id: quoteId,
        operationType: 'offramp',
        terms: quoteTerms,
        expiresAt,
        consumedAt: null,
      })),
      findOperationByIdempotency: vi.fn(async () => null),
      createOperation: vi.fn(async () => ({ id: operationId, existing: false })),
      beginInitiation: vi.fn(async () => true),
      completeInitiation: vi.fn(
        async (input: { instructions: unknown; terms: unknown; expiresAt: Date | null }) => {
          payment = {
            id: operationId,
            operationType: 'offramp',
            status: 'awaiting_chain',
            providerReference: operationId,
            accountId: account.id,
            networkId: account.networkId,
            terms: input.terms,
            instructions: input.instructions,
            expiresAt: input.expiresAt,
          }
        },
      ),
      getForUser: vi.fn(async () => payment),
      bindTransferIntent: vi.fn(async () => undefined),
    } as unknown as OnSwitchPaymentRepository
    const catalogue = {
      requireAvailableSelection: vi.fn(async () => ({
        capabilities: { verifiedNetworks: ['arbitrum-one'] },
        asset: {
          assetKey: 'arbitrum-one:usdc',
          networkId: 'arbitrum-one',
          symbol: 'USDC',
          decimals: 6,
          address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
          onrampAvailable: true,
          offrampAvailable: true,
        },
      })),
      requirements: vi.fn(async () => ({
        data: [
          { path: 'holder_type', regex: '^(INDIVIDUAL|BUSINESS)$', example: 'INDIVIDUAL', required: true },
          { path: 'holder_name', regex: '^.{2,160}$', example: 'Test User', required: true },
          { path: 'account_number', regex: '^\\d{10}$', example: '0123456789', required: true },
          { path: 'bank_code', regex: '^\\d{3}$', example: '058', required: true },
        ],
      })),
    } as unknown as OnSwitchCatalogueService
    const trading = { account: vi.fn(async () => account) } as unknown as TradingRepository
    const withdrawals = {
      createPaymentTransfer: vi.fn(async () => ({ intent: { id: intentId }, existing: false })),
    } as unknown as WithdrawalIntentService
    const payments = new OnSwitchPaymentsService(repository, environment)
    const flow = new OnSwitchPaymentFlowService(
      client,
      catalogue,
      repository,
      payments,
      trading,
      withdrawals,
      environment,
    )

    await flow.quote(userId, 'offramp', {
      accountId: account.id,
      amount: '1.25',
      country: 'NG',
      currency: 'NGN',
      channel: 'BANK',
      assetKey: 'arbitrum-one:usdc',
    })
    await flow.initiateOfframp(userId, quoteId, {
      idempotencyKey: 'onswitch-offramp-key-0001',
      beneficiary: { holder_name: 'Test User', account_number: '0123456789', bank_code: '058' },
    })
    const result = await flow.createOfframpTransferIntent(userId, operationId, 'cashout-transfer-key-1')

    const transferCall = vi.mocked(withdrawals.createPaymentTransfer).mock.calls[0]
    expect(transferCall?.[0]).toBe(userId)
    expect(transferCall?.[1]).toEqual({
      accountId: account.id,
      assetId: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
      toAddress: providerDepositAddress,
      amountRaw: '1250000',
      idempotencyKey: 'cashout-transfer-key-1',
    })
    expect(transferCall?.[2]).toMatchObject({ operationId, providerReference: operationId })
    expect(transferCall?.[2].expiresAt).toBeInstanceOf(Date)
    expect(repository.bindTransferIntent).toHaveBeenCalledWith(userId, operationId, intentId)
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now())
  })
})
