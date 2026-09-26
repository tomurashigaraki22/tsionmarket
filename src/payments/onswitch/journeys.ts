import { Decimal } from 'decimal.js'
import { PublicKey } from '@solana/web3.js'
import { getAddress, isAddress } from 'viem'
import { z } from 'zod'
import type { Environment } from '../../config/env.js'
import type { TradingRepository } from '../../trading/TradingRepository.js'
import type { WithdrawalIntentService } from '../../trading/WithdrawalIntentService.js'
import { AppError } from '../../utils/errors.js'
import { logger } from '../../utils/logger.js'
import type { OnSwitchCatalogueService } from './catalogue.js'
import type { OnSwitchClient, OnSwitchEnvelope } from './client.js'
import { OnSwitchClientError } from './client.js'
import type { OnSwitchPaymentRepository } from './repository.js'
import type { OnSwitchPaymentsService } from './service.js'

const decimalInput = z
  .string()
  .trim()
  .max(64)
  .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/)
  .refine((value) => new Decimal(value).isFinite() && new Decimal(value).isPositive(), {
    message: 'Amount must be greater than zero',
  })
const amountValue = z.union([z.number().finite(), z.string().min(1).max(64)]).transform((value) => {
  const decimal = new Decimal(String(value))
  if (!decimal.isFinite() || decimal.isNegative()) throw new Error('Invalid amount in provider response')
  return decimal.toString()
})
const moneySchema = z
  .object({
    amount: amountValue,
    currency: z.string().min(1).max(16),
    network: z.string().max(80).optional(),
    amount_usd: amountValue.optional(),
  })
  .passthrough()
const quoteResponseSchema = z
  .object({
    rate: amountValue,
    expiry: z.string().min(1).max(80),
    settlement: z.string().max(160).optional(),
    channel: z.enum(['BANK', 'MOBILEMONEY']).optional(),
    fee: z
      .object({
        total: amountValue.optional(),
        platform: amountValue.optional(),
        developer: amountValue.optional(),
        currency: z.string().max(16).optional(),
      })
      .passthrough()
      .optional(),
    fee_inclusive: z.boolean().optional(),
    source: moneySchema,
    destination: moneySchema,
  })
  .passthrough()
const storedSafeQuoteSchema = z
  .object({
    rate: z.string().min(1).max(64),
    expiry: z.string().datetime({ offset: true }),
    settlement: z.string().max(160).nullable(),
    channel: z.string().max(24),
    fee: z
      .object({
        total: z.string().nullable(),
        platform: z.string().nullable(),
        developer: z.string().nullable(),
        currency: z.string().nullable(),
      })
      .strict()
      .nullable(),
    feeInclusive: z.boolean().nullable(),
    source: z.object({ amount: z.string(), currency: z.string() }).strict(),
    destination: z.object({ amount: z.string(), currency: z.string() }).strict(),
  })
  .strict()
const initiationResponseSchema = z
  .object({
    status: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[A-Za-z_]+$/),
    type: z.enum(['ONRAMP', 'OFFRAMP']),
    reference: z.string().uuid(),
    rate: amountValue,
    source: moneySchema,
    destination: moneySchema,
    deposit: z.record(z.string(), z.unknown()),
    created_at: z.string().max(80).optional(),
    expires_at: z.string().max(80).optional(),
  })
  .passthrough()
const statusResponseSchema = z.object({ reference: z.string().uuid(), status: z.string().min(1).max(40) })

export const paymentQuoteInputSchema = z
  .object({
    accountId: z.string().uuid(),
    amount: decimalInput,
    country: z.string().regex(/^[A-Z]{2}$/),
    currency: z.string().regex(/^[A-Z0-9]{3,8}$/),
    channel: z.enum(['BANK', 'MOBILEMONEY']),
    assetKey: z.string().min(3).max(128),
  })
  .strict()

export const onrampInitiateInputSchema = z
  .object({
    idempotencyKey: z.string().min(16).max(200),
    holderType: z.enum(['INDIVIDUAL', 'BUSINESS']),
    holderName: z.string().trim().min(2).max(160),
    payer: z
      .object({
        mobile_number: z.string().trim().min(7).max(32),
        mobile_network: z.string().trim().min(1).max(48),
      })
      .strict()
      .optional(),
  })
  .strict()

export const offrampInitiateInputSchema = z
  .object({
    idempotencyKey: z.string().min(16).max(200),
    savedBeneficiaryId: z.string().uuid().optional(),
    beneficiary: z.record(z.string().min(1).max(128), z.string().trim().min(1).max(256)).optional(),
    senderName: z.string().trim().min(2).max(160).optional(),
    narration: z.string().trim().min(1).max(160).optional(),
    reason: z
      .enum([
        'ADVERTISING_EXPENSES',
        'ADVISORY_FEES',
        'BUSINESS_INSURANCE',
        'COMPUTER_SERVICES',
        'CONSTRUCTION_EXPENSES',
        'DELIVERY_FEES',
        'EDUCATION',
        'EXPORTED_GOODS',
        'FAMILY_SUPPORT',
        'FUND_INVESTMENT',
        'GIFT_AND_DONATION',
        'HOTEL_ACCOMMODATION',
        'INFLUENCER_PAYMENT',
        'INSURANCE_CLAIMS',
        'LIBERALIZED_REMITTANCE',
        'LOAN_PAYMENT',
        'MAINTENANCE_EXPENSES',
        'MEDICAL_TREATMENT',
        'OFFICE_EXPENSES',
        'OTHER',
        'OTHER_FEES',
        'PERSONAL_TRANSFER',
        'PROPERTY_PURCHASE',
        'PROPERTY_RENTAL',
        'REWARD_PAYMENT',
        'ROYALTY_FEES',
        'SALARY_PAYMENT',
        'SERVICE_CHARGES',
        'SHARES_INVESTMENT',
        'SMALL_VALUE_REMITTANCE',
        'TAX_PAYMENT',
        'TRAVEL',
        'TRANSPORTATION_FEES',
        'UTILITY_BILLS',
      ])
      .optional(),
  })
  .strict()
  .refine((input) => Boolean(input.savedBeneficiaryId) !== Boolean(input.beneficiary), {
    message: 'Choose one saved beneficiary or provide beneficiary details',
    path: ['beneficiary'],
  })

type Direction = 'onramp' | 'offramp'
type PaymentQuoteInput = z.infer<typeof paymentQuoteInputSchema>
type SafeQuote = {
  rate: string
  expiry: string
  settlement: string | null
  channel: string
  fee: {
    total: string | null
    platform: string | null
    developer: string | null
    currency: string | null
  } | null
  feeInclusive: boolean | null
  source: { amount: string; currency: string }
  destination: { amount: string; currency: string }
}
type QuoteTerms = {
  version: 1
  operationType: Direction
  accountId: string
  accountAddress: string
  networkId: string
  asset: {
    assetKey: string
    networkId: string
    symbol: string
    decimals: number
    address: string
    providerAsset: string
  }
  providerRequest: Record<string, unknown>
  quote: SafeQuote
}

export class OnSwitchPaymentFlowService {
  constructor(
    private readonly client: OnSwitchClient | null,
    private readonly catalogue: OnSwitchCatalogueService,
    private readonly repository: OnSwitchPaymentRepository,
    private readonly payments: OnSwitchPaymentsService,
    private readonly trading: TradingRepository,
    private readonly withdrawals: WithdrawalIntentService,
    private readonly environment: Environment,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async quote(userId: string, operationType: Direction, input: PaymentQuoteInput) {
    this.assertDirectionStartsEnabled(operationType)
    const { account, asset, providerAsset, corridor } = await this.resolveSelection(
      userId,
      operationType,
      input,
    )
    const amount = providerNumber(input.amount, operationType === 'offramp' ? asset.decimals : 6)
    const providerRequest: Record<string, unknown> = {
      amount,
      country: input.country,
      currency: input.currency,
      asset: providerAsset,
      channel: input.channel,
      exact_output: false,
      ...(operationType === 'offramp' ? { wallet: account.address } : {}),
    }
    const quote = await this.requestQuote(operationType, providerRequest)
    validateQuoteDirection(quote, operationType, input.currency, asset.symbol, input.channel)
    if (!new Decimal(quote.source.amount).eq(input.amount))
      throw new AppError(
        'PAYMENT_PROVIDER_TERMS_MISMATCH',
        'Provider quote does not match the amount you requested',
        502,
      )
    const fiatAmount = operationType === 'onramp' ? quote.source.amount : quote.destination.amount
    assertCorridorAmountWithinLimits(corridor, input.channel, fiatAmount)
    const providerExpiry = validDate(quote.expiry)
    const expiresAt = new Date(Math.min(providerExpiry.getTime(), this.now().getTime() + 60_000))
    if (expiresAt.getTime() <= this.now().getTime())
      throw new AppError('PAYMENT_QUOTE_EXPIRED', 'The provider quote has already expired', 409)

    const terms: QuoteTerms = {
      version: 1,
      operationType,
      accountId: account.id,
      accountAddress: account.address,
      networkId: account.networkId,
      asset: {
        assetKey: asset.assetKey,
        networkId: asset.networkId,
        symbol: asset.symbol,
        decimals: asset.decimals,
        address: asset.address,
        providerAsset,
      },
      providerRequest,
      quote,
    }
    const stored = await this.payments.createQuote(
      userId,
      operationType,
      {
        country: input.country,
        fiatCurrency: input.currency,
        channel: input.channel,
        assetKey: asset.assetKey,
        sourceAmount: quote.source.amount,
        destinationAmount: quote.destination.amount,
        ...(operationType === 'offramp'
          ? {
              sourceAmountRaw: toRawAmount(quote.source.amount, asset.decimals),
              sourceDecimals: asset.decimals,
            }
          : {
              destinationAmountRaw: toRawAmount(quote.destination.amount, asset.decimals),
              destinationDecimals: asset.decimals,
            }),
        rate: quote.rate,
        feeAmount: quote.fee?.total ?? undefined,
        termsSnapshot: terms,
        expiresAt,
      },
      { accountId: account.id, networkId: account.networkId, amount: input.amount, providerRequest },
    )
    return { id: stored.id, expiresAt, ...quote }
  }

  async initiateOnramp(
    userId: string,
    quoteId: string,
    input: z.infer<typeof onrampInitiateInputSchema>,
    requestId?: string,
  ) {
    const quote = await this.loadQuote(userId, 'onramp', quoteId)
    const fingerprint = {
      quoteId,
      holderType: input.holderType,
      holderName: input.holderName,
      payer: input.payer ?? null,
    }
    const replay = await this.payments.findOperationReplay(
      userId,
      input.idempotencyKey,
      'onramp',
      fingerprint,
    )
    const replayPayment = replay ? await this.requirePayment(userId, replay.id) : null
    if (replayPayment && replayPayment.status !== 'created') return { payment: replayPayment, existing: true }
    this.assertDirectionStartsEnabled('onramp')
    if (!replay && quote.consumedAt)
      throw new AppError('PAYMENT_QUOTE_CONSUMED', 'This quote has already been used', 409)
    if (quote.terms.providerRequest.channel === 'MOBILEMONEY') {
      if (!input.payer)
        throw new AppError('PAYMENT_PAYER_REQUIRED', 'Mobile-money payer details are required', 400)
    } else if (input.payer) {
      throw new AppError('PAYMENT_PAYER_NOT_ALLOWED', 'Payer details are only accepted for mobile money', 400)
    }
    await this.validateOnrampRequirements(quote.terms, input)
    await this.revalidateQuote(quote)
    const operation = await this.payments.createOperation(
      userId,
      input.idempotencyKey,
      this.operationInput(quote, null),
      fingerprint,
    )
    if (operation.existing) {
      const existingPayment = await this.requirePayment(userId, operation.id)
      if (existingPayment.status !== 'created') return { payment: existingPayment, existing: true }
    }
    const body: Record<string, unknown> = {
      ...quote.terms.providerRequest,
      reference: operation.id,
      beneficiary: {
        holder_type: input.holderType,
        holder_name: input.holderName,
        wallet_address: quote.terms.accountAddress,
      },
      ...(input.payer ? { payer: input.payer } : {}),
    }
    return this.initiateProviderOperation(userId, operation.id, 'onramp', body, quote, requestId)
  }

  async initiateOfframp(
    userId: string,
    quoteId: string,
    input: z.infer<typeof offrampInitiateInputSchema>,
    requestId?: string,
  ) {
    const quote = await this.loadQuote(userId, 'offramp', quoteId)
    const fingerprint = {
      quoteId,
      beneficiary: input.savedBeneficiaryId
        ? { savedBeneficiaryId: input.savedBeneficiaryId }
        : (input.beneficiary ?? null),
      senderName: input.senderName ?? null,
      narration: input.narration ?? null,
      reason: input.reason ?? null,
    }
    const replay = await this.payments.findOperationReplay(
      userId,
      input.idempotencyKey,
      'offramp',
      fingerprint,
    )
    const replayPayment = replay ? await this.requirePayment(userId, replay.id) : null
    if (replayPayment && replayPayment.status !== 'created') return { payment: replayPayment, existing: true }
    this.assertDirectionStartsEnabled('offramp')
    if (!replay && quote.consumedAt)
      throw new AppError('PAYMENT_QUOTE_CONSUMED', 'This quote has already been used', 409)
    const beneficiary = await this.resolveOfframpBeneficiary(userId, quote.terms, input)

    await this.revalidateQuote(quote)
    const operation = await this.payments.createOperation(
      userId,
      input.idempotencyKey,
      this.operationInput(quote, beneficiary.localReferenceId),
      fingerprint,
    )
    if (operation.existing) {
      const existingPayment = await this.requirePayment(userId, operation.id)
      if (existingPayment.status !== 'created') return { payment: existingPayment, existing: true }
    }
    const body: Record<string, unknown> = {
      ...quote.terms.providerRequest,
      reference: operation.id,
      beneficiary: beneficiary.providerPayload,
      refund_address: quote.terms.accountAddress,
      ...(input.senderName ? { sender_name: input.senderName } : {}),
      ...(input.narration ? { narration: input.narration } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    }
    return this.initiateProviderOperation(userId, operation.id, 'offramp', body, quote, requestId)
  }

  async createOfframpTransferIntent(userId: string, paymentId: string, idempotencyKey: string) {
    if (this.environment.ONSWITCH_ENVIRONMENT === 'sandbox' && this.environment.NETWORK_MODE === 'mainnet')
      throw new AppError(
        'PAYMENT_SANDBOX_TRANSFER_DISABLED',
        'Sandbox payouts cannot request a real mainnet wallet transfer',
        409,
      )
    const payment = await this.requirePayment(userId, paymentId)
    if (payment.operationType !== 'offramp')
      throw new AppError('PAYMENT_NOT_FOUND', 'Off-ramp payment not found', 404)
    if (payment.status !== 'awaiting_chain')
      throw new AppError(
        'PAYMENT_NOT_READY_FOR_TRANSFER',
        'Payment is not waiting for a wallet transfer',
        409,
      )
    if (!payment.providerReference || !payment.accountId || !payment.networkId)
      throw new AppError(
        'PAYMENT_TRANSFER_INVALID',
        'Payment is missing its verified wallet instructions',
        409,
      )
    if (!payment.expiresAt || payment.expiresAt.getTime() <= this.now().getTime())
      throw new AppError(
        'PAYMENT_DEPOSIT_EXPIRED',
        'The provider deposit instructions have expired or omitted a safe expiry',
        409,
      )
    const terms = parseQuoteTerms(payment.terms)
    const instruction = asRecord(payment.instructions)
    const deposit = asRecord(instruction.deposit)
    const recipient = stringValue(deposit.address, 256)
    const providerAsset = stringValue(deposit.asset, 64)
    const amount = decimalString(deposit.amount)
    if (!recipient || !providerAsset || !amount)
      throw new AppError('PAYMENT_TRANSFER_INVALID', 'Provider deposit instructions are incomplete', 409)
    if (normalizeProviderAsset(providerAsset) !== normalizeProviderAsset(terms.asset.providerAsset))
      throw new AppError(
        'PAYMENT_ASSET_MISMATCH',
        'Provider returned a deposit asset on another network',
        409,
      )
    const amountRaw = toRawAmount(amount, terms.asset.decimals)
    const result = await this.withdrawals.createPaymentTransfer(
      userId,
      {
        accountId: payment.accountId,
        assetId: terms.asset.address,
        toAddress: recipient,
        amountRaw,
        idempotencyKey,
      },
      {
        operationId: payment.id,
        providerReference: payment.providerReference,
        expiresAt: payment.expiresAt,
      },
    )
    const intentId = asRecord(result.intent).id
    if (typeof intentId !== 'string')
      throw new AppError('PAYMENT_TRANSFER_INTENT_INVALID', 'Created transfer intent has no identifier', 500)
    await this.repository.bindTransferIntent(userId, paymentId, intentId)
    return { ...result, paymentId, expiresAt: payment.expiresAt }
  }

  async refresh(userId: string, paymentId: string) {
    const payment = await this.requirePayment(userId, paymentId)
    if (!payment.providerReference)
      throw new AppError('PAYMENT_STATUS_UNAVAILABLE', 'Payment has no provider reference yet', 409)
    const response = await this.provider().get('/payment/status', { reference: payment.providerReference })
    const status = statusResponseSchema.safeParse(response.data)
    if (!status.success || status.data.reference !== payment.providerReference)
      throw new AppError(
        'PAYMENT_PROVIDER_INVALID_RESPONSE',
        'Provider returned an invalid payment status',
        502,
      )
    const snapshot = normalizePaymentStatusSnapshot(response.data, payment.operationType, payment.terms)
    await this.repository.applyProviderStatus(payment.id, status.data.status, snapshot ?? undefined)
    return this.requirePayment(userId, paymentId)
  }

  private async resolveSelection(userId: string, direction: Direction, input: PaymentQuoteInput) {
    const { capabilities, asset, corridor } = await this.catalogue.requireAvailableSelection({
      userId,
      operationType: direction,
      country: input.country,
      currency: input.currency,
      channel: input.channel,
      assetKey: input.assetKey,
    })
    if (!asset || !corridor)
      throw new AppError(
        'PAYMENT_ASSET_UNSUPPORTED',
        'Stablecoin is not available for this payment route',
        400,
      )
    const account = await this.trading.account(userId, input.accountId)
    if (!account)
      throw new AppError('PAYMENT_ACCOUNT_UNAVAILABLE', 'Choose a verified wallet account first', 409)
    if (account.networkId !== asset.networkId || !capabilities.verifiedNetworks.includes(account.networkId))
      throw new AppError(
        'PAYMENT_NETWORK_MISMATCH',
        'Stablecoin and verified wallet must use the same network',
        400,
      )
    const providerAsset = toProviderAsset(asset.networkId, asset.symbol)
    const address = canonicalWalletAddress(account.family, account.address)
    return { account: { ...account, address }, asset, providerAsset, corridor }
  }

  private assertDirectionStartsEnabled(direction: Direction): void {
    const enabled =
      direction === 'onramp'
        ? this.environment.ONSWITCH_ONRAMP_STARTS_ENABLED
        : this.environment.ONSWITCH_OFFRAMP_STARTS_ENABLED
    if (!enabled)
      throw new AppError(
        'PAYMENT_DIRECTION_PAUSED',
        'New payments in this direction are temporarily paused. Existing payments remain available.',
        503,
      )
  }

  private async requestQuote(direction: Direction, body: Record<string, unknown>): Promise<SafeQuote> {
    const path = direction === 'onramp' ? '/onramp/quote' : '/offramp/quote'
    const response = await this.provider().post(path, body)
    const parsed = quoteResponseSchema.safeParse(response.data)
    if (!parsed.success)
      throw new AppError('PAYMENT_PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid quote', 502)
    return normalizeQuote(parsed.data)
  }

  private async revalidateQuote(quote: { terms: QuoteTerms; expiresAt: Date }) {
    if (quote.expiresAt.getTime() <= this.now().getTime())
      throw new AppError('PAYMENT_QUOTE_EXPIRED', 'Payment quote expired; request a new quote', 409)
    const current = await this.requestQuote(quote.terms.operationType, quote.terms.providerRequest)
    if (quoteFingerprint(current) !== quoteFingerprint(quote.terms.quote))
      throw new AppError(
        'PAYMENT_QUOTE_CHANGED',
        'The provider quote changed; review a fresh quote before continuing',
        409,
      )
  }

  private async loadQuote(userId: string, direction: Direction, quoteId: string) {
    const stored = await this.repository.getQuoteForUser(userId, quoteId)
    if (!stored || stored.operationType !== direction)
      throw new AppError('PAYMENT_QUOTE_NOT_FOUND', 'Payment quote not found', 404)
    const terms = parseQuoteTerms(stored.terms)
    if (terms.operationType !== direction)
      throw new AppError('PAYMENT_QUOTE_MISMATCH', 'Quote does not match this payment direction', 409)
    return { id: stored.id, terms, expiresAt: stored.expiresAt, consumedAt: stored.consumedAt }
  }

  private operationInput(
    quote: { id: string; terms: QuoteTerms; expiresAt: Date },
    beneficiaryRefId: string | null,
  ) {
    return {
      operationType: quote.terms.operationType,
      accountId: quote.terms.accountId,
      networkId: quote.terms.networkId,
      quoteId: quote.id,
      ...(beneficiaryRefId ? { beneficiaryRefId } : {}),
      country: String(quote.terms.providerRequest.country),
      fiatCurrency: String(quote.terms.providerRequest.currency),
      channel: String(quote.terms.providerRequest.channel),
      assetKey: quote.terms.asset.assetKey,
      sourceAmount: quote.terms.quote.source.amount,
      destinationAmount: quote.terms.quote.destination.amount,
      ...(quote.terms.operationType === 'offramp'
        ? {
            sourceAmountRaw: toRawAmount(quote.terms.quote.source.amount, quote.terms.asset.decimals),
            sourceDecimals: quote.terms.asset.decimals,
          }
        : {
            destinationAmountRaw: toRawAmount(
              quote.terms.quote.destination.amount,
              quote.terms.asset.decimals,
            ),
            destinationDecimals: quote.terms.asset.decimals,
          }),
      termsSnapshot: quote.terms as unknown as Record<string, unknown>,
      expiresAt: quote.expiresAt,
    }
  }

  private async initiateProviderOperation(
    userId: string,
    operationId: string,
    direction: Direction,
    body: Record<string, unknown>,
    quote: { terms: QuoteTerms },
    requestId?: string,
  ) {
    const began = await this.repository.beginInitiation(operationId)
    if (!began) return { payment: await this.requirePayment(userId, operationId), existing: true }
    let response: OnSwitchEnvelope
    try {
      response = await this.provider().post(
        direction === 'onramp' ? '/onramp/initiate' : '/offramp/initiate',
        body,
      )
    } catch (error) {
      if (error instanceof OnSwitchClientError) {
        logger.warn('OnSwitch payment initiation failed', {
          ...(requestId ? { requestId } : {}),
          operationId,
          direction,
          providerErrorCode: error.code,
          providerStatusCode: error.statusCode,
          retryable: error.retryable,
          ...(error.providerCode ? { providerCode: error.providerCode } : {}),
          ...(error.providerMessage ? { providerMessage: error.providerMessage } : {}),
        })
      }
      const ambiguous =
        !(error instanceof OnSwitchClientError) || error.retryable || error.code === 'INVALID_RESPONSE'
      const code = error instanceof OnSwitchClientError ? error.code : 'PROVIDER_ERROR'
      await this.repository.recordInitiationFailure(operationId, code, ambiguous)
      throw new AppError(
        ambiguous ? 'PAYMENT_INITIATION_UNKNOWN' : 'PAYMENT_INITIATION_REJECTED',
        ambiguous
          ? 'Provider response is uncertain. Refresh payment status before retrying.'
          : 'The provider rejected this payment. Request a new quote and try again.',
        ambiguous ? 503 : 422,
      )
    }
    const parsed = initiationResponseSchema.safeParse(response.data)
    if (!parsed.success || parsed.data.type !== direction.toUpperCase()) {
      await this.repository.recordInitiationFailure(operationId, 'INVALID_PROVIDER_INITIATION', true)
      throw new AppError(
        'PAYMENT_INITIATION_UNKNOWN',
        'Provider response could not be verified. Refresh payment status before retrying.',
        502,
      )
    }
    let normalized: ReturnType<typeof normalizeInitiation>
    try {
      normalized = normalizeInitiation(parsed.data, direction, quote.terms)
    } catch (error) {
      await this.repository.recordInitiationFailure(operationId, 'INVALID_PROVIDER_INSTRUCTIONS', true)
      if (error instanceof AppError && error.statusCode === 502)
        throw new AppError(
          'PAYMENT_INITIATION_UNKNOWN',
          'Provider instructions could not be verified. Refresh payment status before retrying.',
          502,
        )
      throw error
    }
    await this.repository.completeInitiation({
      operationId,
      providerReference: parsed.data.reference,
      providerStatus: parsed.data.status,
      operationType: direction,
      instructions: normalized.instructions,
      terms: { ...quote.terms, initiation: normalized.terms },
      expiresAt: normalized.expiresAt,
    })
    return { payment: await this.requirePayment(userId, operationId), existing: false }
  }

  private async resolveOfframpBeneficiary(
    userId: string,
    terms: QuoteTerms,
    input: z.infer<typeof offrampInitiateInputSchema>,
  ) {
    if (input.savedBeneficiaryId) {
      const references = await this.catalogue.beneficiaryReferences(userId)
      const reference = references.find((candidate) => candidate.id === input.savedBeneficiaryId)
      if (!reference) throw new AppError('PAYMENT_BENEFICIARY_NOT_FOUND', 'Saved beneficiary not found', 404)
      if (
        (reference.country && reference.country !== String(terms.providerRequest.country)) ||
        (reference.fiatCurrency && reference.fiatCurrency !== String(terms.providerRequest.currency)) ||
        (reference.channel && reference.channel !== String(terms.providerRequest.channel))
      )
        throw new AppError(
          'PAYMENT_BENEFICIARY_MISMATCH',
          'Saved beneficiary does not match this payment route',
          400,
        )
      const refreshed = await this.catalogue.refreshBeneficiary(userId, reference.id)
      if (!refreshed.data.exists)
        throw new AppError(
          'PAYMENT_BENEFICIARY_UNAVAILABLE',
          'Saved beneficiary is no longer available at the provider',
          409,
        )
      return {
        providerPayload: { id: reference.providerBeneficiaryId },
        localReferenceId: reference.id,
        fingerprint: { savedBeneficiaryId: reference.id },
      }
    }
    const beneficiary = input.beneficiary
    if (!beneficiary)
      throw new AppError('PAYMENT_BENEFICIARY_REQUIRED', 'Enter the payout recipient details', 400)
    const requirements = await this.catalogue.requirements({
      direction: 'OFFRAMP',
      country: String(terms.providerRequest.country),
      currency: String(terms.providerRequest.currency),
      channel: String(terms.providerRequest.channel) as 'BANK' | 'MOBILEMONEY',
      holderType: beneficiary.holder_type === 'BUSINESS' ? 'BUSINESS' : 'INDIVIDUAL',
    })
    const allowed = new Map<string, { required: boolean; regex: string }>()
    const topLevelRequirements = new Map<string, { required: boolean; regex: string }>()
    for (const field of requirements.data) {
      const path = field.path.replace(/^beneficiary\./, '')
      if (['channel', 'sender_name', 'narration', 'reason'].includes(path)) {
        topLevelRequirements.set(path, { required: field.required, regex: field.regex })
      } else if (isSafeBeneficiaryPath(path)) {
        allowed.set(path, { required: field.required, regex: field.regex })
      } else if (field.required) {
        throw new AppError(
          'PAYMENT_REQUIREMENT_UNSUPPORTED',
          'Provider requires an unsupported payout field',
          503,
        )
      }
    }
    for (const field of ['holder_type', 'holder_name']) {
      if (!allowed.has(field))
        allowed.set(field, {
          required: true,
          regex: field === 'holder_type' ? '^(INDIVIDUAL|BUSINESS)$' : '^.{2,160}$',
        })
    }
    const values: Record<string, string> = { ...beneficiary }
    values.holder_type ??= 'INDIVIDUAL'
    for (const [path, value] of Object.entries(values)) {
      const rule = allowed.get(path)
      if (!rule || !new RegExp(rule.regex).test(value))
        throw new AppError(
          'PAYMENT_BENEFICIARY_INVALID',
          `Invalid or unsupported beneficiary field: ${path}`,
          400,
        )
    }
    for (const [path, rule] of allowed) {
      if (rule.required && !(path in values))
        throw new AppError('PAYMENT_BENEFICIARY_REQUIRED', `Missing required beneficiary field: ${path}`, 400)
    }
    const topLevelValues: Record<string, string | undefined> = {
      channel: String(terms.providerRequest.channel),
      sender_name: input.senderName,
      narration: input.narration,
      reason: input.reason,
    }
    for (const [path, rule] of topLevelRequirements) {
      const value = topLevelValues[path]
      if (!value && rule.required)
        throw new AppError('PAYMENT_BENEFICIARY_REQUIRED', `Missing required payment field: ${path}`, 400)
      if (value && !new RegExp(rule.regex).test(value))
        throw new AppError('PAYMENT_BENEFICIARY_INVALID', `Invalid payment field: ${path}`, 400)
    }
    const payload: Record<string, unknown> = {}
    for (const [path, value] of Object.entries(values)) setSafePath(payload, path, value)
    return { providerPayload: payload, localReferenceId: null, fingerprint: values }
  }

  private async validateOnrampRequirements(
    terms: QuoteTerms,
    input: z.infer<typeof onrampInitiateInputSchema>,
  ) {
    const requirements = await this.catalogue.requirements({
      direction: 'ONRAMP',
      country: String(terms.providerRequest.country),
      currency: String(terms.providerRequest.currency),
      channel: terms.providerRequest.channel as 'BANK' | 'MOBILEMONEY',
      holderType: input.holderType,
    })
    const values: Record<string, string> = {
      holder_type: input.holderType,
      holder_name: input.holderName,
      wallet_address: terms.accountAddress,
      channel: String(terms.providerRequest.channel),
      'beneficiary.holder_type': input.holderType,
      'beneficiary.holder_name': input.holderName,
      'beneficiary.wallet_address': terms.accountAddress,
      'beneficiary.channel': String(terms.providerRequest.channel),
      ...(input.payer
        ? {
            mobile_number: input.payer.mobile_number,
            mobile_network: input.payer.mobile_network,
            'payer.mobile_number': input.payer.mobile_number,
            'payer.mobile_network': input.payer.mobile_network,
          }
        : {}),
    }
    for (const field of requirements.data) {
      if (!isSafeBeneficiaryPath(field.path)) {
        if (field.required)
          throw new AppError(
            'PAYMENT_REQUIREMENT_UNSUPPORTED',
            'Provider requires an unsupported on-ramp field',
            503,
          )
        continue
      }
      const value = values[field.path] ?? values[field.path.replace(/^(?:beneficiary|payer)\./, '')]
      if (!value && field.required)
        throw new AppError(
          'PAYMENT_BENEFICIARY_REQUIRED',
          `Missing required on-ramp field: ${field.path}`,
          400,
        )
      if (value && !new RegExp(field.regex).test(value))
        throw new AppError('PAYMENT_BENEFICIARY_INVALID', `Invalid on-ramp field: ${field.path}`, 400)
    }
  }

  private async requirePayment(userId: string, id: string) {
    const payment = await this.repository.getForUser(userId, id)
    if (!payment) throw new AppError('PAYMENT_NOT_FOUND', 'Payment not found', 404)
    return payment
  }

  private provider(): OnSwitchClient {
    if (!this.client || !this.environment.ONSWITCH_ENABLED)
      throw new AppError('PAYMENTS_UNAVAILABLE', 'In-app payments are not enabled', 503)
    return this.client
  }
}

function normalizeQuote(value: z.infer<typeof quoteResponseSchema>): SafeQuote {
  const expiry = validDate(value.expiry).toISOString()
  if (
    !new Decimal(value.rate).isPositive() ||
    !new Decimal(value.source.amount).isPositive() ||
    !new Decimal(value.destination.amount).isPositive()
  )
    throw new AppError(
      'PAYMENT_PROVIDER_INVALID_RESPONSE',
      'Provider quote contains a zero or invalid amount',
      502,
    )
  return {
    rate: value.rate,
    expiry,
    settlement: safeText(value.settlement, 160),
    channel: value.channel ?? '',
    fee: value.fee
      ? {
          total: value.fee.total ?? null,
          platform: value.fee.platform ?? null,
          developer: value.fee.developer ?? null,
          currency: safeText(value.fee.currency, 16),
        }
      : null,
    feeInclusive: value.fee_inclusive ?? null,
    source: { amount: value.source.amount, currency: safeText(value.source.currency, 16) ?? '' },
    destination: {
      amount: value.destination.amount,
      currency: safeText(value.destination.currency, 16) ?? '',
    },
  }
}

function validateQuoteDirection(
  quote: SafeQuote,
  direction: Direction,
  currency: string,
  symbol: string,
  channel: 'BANK' | 'MOBILEMONEY',
) {
  const expectedSource = direction === 'onramp' ? currency : symbol
  const expectedDestination = direction === 'onramp' ? symbol : currency
  if (
    quote.source.currency.toUpperCase() !== expectedSource.toUpperCase() ||
    quote.destination.currency.toUpperCase() !== expectedDestination.toUpperCase() ||
    (quote.channel && quote.channel !== channel)
  )
    throw new AppError(
      'PAYMENT_PROVIDER_INVALID_RESPONSE',
      'Provider quote does not match the selected route',
      502,
    )
}

export function assertCorridorAmountWithinLimits(
  corridor: {
    payoutLimits: Record<string, { min?: string | undefined; max?: string | undefined } | string>
  },
  channel: string,
  fiatAmount: string,
): void {
  const advertised = corridor.payoutLimits[channel]
  if (!advertised || typeof advertised === 'string') return
  const amount = new Decimal(fiatAmount)
  const min = parseProviderLimit(advertised.min)
  const max = parseProviderLimit(advertised.max)
  if ((min && amount.lessThan(min)) || (max && amount.greaterThan(max)))
    throw new AppError(
      'PAYMENT_CORRIDOR_LIMIT',
      'The requested amount is outside the provider’s current limit for this route',
      400,
    )
}

function parseProviderLimit(value: string | undefined): Decimal | null {
  if (!value || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null
  const amount = new Decimal(value)
  return amount.isFinite() && !amount.isNegative() ? amount : null
}

function quoteFingerprint(quote: SafeQuote) {
  return JSON.stringify({
    rate: quote.rate,
    channel: quote.channel,
    fee: quote.fee,
    feeInclusive: quote.feeInclusive,
    source: quote.source,
    destination: quote.destination,
  })
}

function normalizeInitiation(
  value: z.infer<typeof initiationResponseSchema>,
  direction: Direction,
  terms: QuoteTerms,
) {
  const deposit = value.deposit
  const notes = Array.isArray(deposit.note)
    ? deposit.note
        .map((item) => safeText(item, 500))
        .filter((item): item is string => Boolean(item))
        .slice(0, 8)
    : safeText(deposit.note, 500)
      ? [safeText(deposit.note, 500)!]
      : []
  const amount = decimalString(deposit.amount)
  const asset = stringValue(deposit.asset, 64)
  const address = stringValue(deposit.address, 256)
  if (!amount || !asset)
    throw new AppError(
      'PAYMENT_PROVIDER_INVALID_RESPONSE',
      'Provider deposit instructions are incomplete',
      502,
    )
  if (
    !new Decimal(amount).eq(terms.quote.source.amount) ||
    !new Decimal(value.source.amount).eq(terms.quote.source.amount) ||
    !new Decimal(value.destination.amount).eq(terms.quote.destination.amount) ||
    value.source.currency.toUpperCase() !== terms.quote.source.currency.toUpperCase() ||
    value.destination.currency.toUpperCase() !== terms.quote.destination.currency.toUpperCase()
  )
    throw new AppError(
      'PAYMENT_PROVIDER_TERMS_MISMATCH',
      'Provider initiation does not match the reviewed quote',
      502,
    )
  const normalizedAsset = normalizeProviderAsset(asset)
  if (normalizedAsset !== normalizeProviderAsset(terms.asset.providerAsset))
    throw new AppError(
      'PAYMENT_PROVIDER_ASSET_MISMATCH',
      'Provider deposit asset does not match the quoted wallet network',
      502,
    )
  if (direction === 'offramp' && !address)
    throw new AppError(
      'PAYMENT_PROVIDER_INVALID_RESPONSE',
      'Provider did not return its deposit address',
      502,
    )
  const rawExpiry = validDateOrNull(deposit.expires_at ?? value.expires_at)
  const expiresAt = rawExpiry ?? expiryFromProviderNotes(notes, value.created_at)
  const safeDeposit: Record<string, unknown> = {
    amount,
    asset,
    ...(address ? { address } : {}),
    ...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}),
    ...(stringValue(deposit.account_number, 80)
      ? { accountNumber: stringValue(deposit.account_number, 80) }
      : {}),
    ...(stringValue(deposit.account_name, 160)
      ? { accountName: stringValue(deposit.account_name, 160) }
      : {}),
    ...(stringValue(deposit.bank_code, 80) ? { bankCode: stringValue(deposit.bank_code, 80) } : {}),
    ...(stringValue(deposit.bank_name, 160) ? { bankName: stringValue(deposit.bank_name, 160) } : {}),
    ...(stringValue(deposit.mobile_number, 40)
      ? { mobileNumber: stringValue(deposit.mobile_number, 40) }
      : {}),
    ...(stringValue(deposit.mobile_network, 80)
      ? { mobileNetwork: stringValue(deposit.mobile_network, 80) }
      : {}),
    notes,
  }
  const safeTerms = {
    providerStatus: value.status,
    providerType: value.type,
    rate: value.rate,
    source: value.source,
    destination: value.destination,
    createdAt: safeText(value.created_at, 80),
  }
  return { instructions: { deposit: safeDeposit }, terms: safeTerms, expiresAt }
}

export function normalizePaymentStatusSnapshot(
  value: unknown,
  direction: Direction,
  storedTerms: unknown,
): { instructions: Record<string, unknown>; terms: Record<string, unknown>; expiresAt: Date | null } | null {
  const parsed = initiationResponseSchema.safeParse(value)
  if (!parsed.success || parsed.data.type !== direction.toUpperCase()) return null
  try {
    const quoteTerms = parseQuoteTerms(storedTerms)
    const normalized = normalizeInitiation(parsed.data, direction, quoteTerms)
    return {
      instructions: normalized.instructions,
      terms: { ...quoteTerms, initiation: normalized.terms },
      expiresAt: normalized.expiresAt,
    }
  } catch {
    return null
  }
}

function parseQuoteTerms(value: unknown): QuoteTerms {
  const object = asRecord(value)
  if (
    object.version !== 1 ||
    (object.operationType !== 'onramp' && object.operationType !== 'offramp') ||
    typeof object.accountId !== 'string' ||
    typeof object.accountAddress !== 'string' ||
    typeof object.networkId !== 'string' ||
    typeof object.asset !== 'object' ||
    object.asset === null ||
    typeof object.providerRequest !== 'object' ||
    object.providerRequest === null ||
    typeof object.quote !== 'object' ||
    object.quote === null
  )
    throw new AppError('PAYMENT_TERMS_INVALID', 'Stored payment terms are invalid', 409)
  const asset = object.asset as Record<string, unknown>
  if (
    typeof asset.assetKey !== 'string' ||
    typeof asset.networkId !== 'string' ||
    typeof asset.symbol !== 'string' ||
    typeof asset.decimals !== 'number' ||
    typeof asset.address !== 'string' ||
    typeof asset.providerAsset !== 'string'
  )
    throw new AppError('PAYMENT_TERMS_INVALID', 'Stored payment asset is invalid', 409)
  const quote = storedSafeQuoteSchema.safeParse(object.quote)
  if (!quote.success) throw new AppError('PAYMENT_TERMS_INVALID', 'Stored payment quote is invalid', 409)
  const providerRequest = asRecord(object.providerRequest)
  return {
    version: 1,
    operationType: object.operationType,
    accountId: object.accountId,
    accountAddress: object.accountAddress,
    networkId: object.networkId,
    asset: {
      assetKey: asset.assetKey,
      networkId: asset.networkId,
      symbol: asset.symbol,
      decimals: asset.decimals,
      address: asset.address,
      providerAsset: asset.providerAsset,
    },
    providerRequest,
    quote: quote.data,
  }
}

function providerNumber(value: string, maximumDecimals: number): number {
  const decimal = new Decimal(value)
  if (!decimal.isFinite() || !decimal.isPositive() || decimal.decimalPlaces() > maximumDecimals)
    throw new AppError(
      'PAYMENT_AMOUNT_INVALID',
      `Amount supports up to ${maximumDecimals} decimal places`,
      400,
    )
  const number = decimal.toNumber()
  if (!Number.isFinite(number) || !new Decimal(number.toString()).eq(decimal))
    throw new AppError(
      'PAYMENT_AMOUNT_PRECISION',
      'Amount cannot be represented safely by the provider API',
      400,
    )
  return number
}

function toRawAmount(value: string, decimals: number): string {
  const amount = new Decimal(value)
  if (amount.decimalPlaces() > decimals)
    throw new AppError('PAYMENT_AMOUNT_PRECISION', 'Provider deposit amount exceeds token precision', 409)
  return amount.mul(new Decimal(10).pow(decimals)).toFixed(0)
}

function toProviderAsset(networkId: string, symbol: string): string {
  const network: Record<string, string> = {
    'ethereum-mainnet': 'ethereum',
    'arbitrum-one': 'arbitrum',
    'solana-mainnet-beta': 'solana',
  }
  const providerNetwork = network[networkId]
  if (!providerNetwork)
    throw new AppError(
      'PAYMENT_ASSET_UNSUPPORTED',
      'This wallet network is not supported by the payment provider',
      400,
    )
  return `${providerNetwork}:${symbol.toLowerCase()}`
}

function normalizeProviderAsset(value: string): string {
  return value.toLowerCase().replace(/[-_]/g, '')
}

function canonicalWalletAddress(family: string, value: string): string {
  if (family === 'evm' && isAddress(value)) return getAddress(value)
  if (family === 'solana') {
    try {
      return new PublicKey(value).toBase58()
    } catch {
      // Fall through to the common error.
    }
  }
  throw new AppError('PAYMENT_ACCOUNT_INVALID', 'Verified wallet address is invalid for this network', 409)
}

function validDate(value: string): Date {
  const date = validDateOrNull(value)
  if (!date) throw new AppError('PAYMENT_PROVIDER_INVALID_RESPONSE', 'Provider quote expiry is invalid', 502)
  return date
}

function validDateOrNull(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length > 80) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

function expiryFromProviderNotes(notes: string[], createdAt: unknown): Date | null {
  const note = notes.find((value) => /expiry window|expires? in/i.test(value))
  const duration = note?.match(/\b(\d{1,4})\s+minutes?\b/i)
  const base = validDateOrNull(createdAt)
  if (!duration || !base) return null
  const minutes = Number(duration[1])
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return null
  return new Date(base.getTime() + minutes * 60_000)
}

function decimalString(value: unknown): string | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  try {
    const amount = new Decimal(String(value))
    return amount.isFinite() && amount.isPositive() ? amount.toString() : null
  } catch {
    return null
  }
}

function stringValue(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
    ? stripControlCharacters(value).trim()
    : null
}

function safeText(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0
    ? stripControlCharacters(value).trim().slice(0, max) || null
    : null
}

function stripControlCharacters(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0)
      return code >= 32 && code !== 127
    })
    .join('')
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function isSafeBeneficiaryPath(path: string): boolean {
  return /^(?!__proto__$|prototype$|constructor$)[A-Za-z][A-Za-z0-9_-]{0,63}(?:\.(?!__proto__$|prototype$|constructor$)[A-Za-z][A-Za-z0-9_-]{0,63}){0,3}$/.test(
    path,
  )
}

function setSafePath(target: Record<string, unknown>, path: string, value: string) {
  if (!isSafeBeneficiaryPath(path))
    throw new AppError(
      'PAYMENT_REQUIREMENT_INVALID',
      'Provider returned an unsupported beneficiary field',
      502,
    )
  const parts = path.split('.')
  let current = target
  for (const part of parts.slice(0, -1)) {
    const existing = current[part]
    if (typeof existing !== 'object' || existing === null) current[part] = {}
    current = current[part] as Record<string, unknown>
  }
  current[parts.at(-1)!] = value
}
