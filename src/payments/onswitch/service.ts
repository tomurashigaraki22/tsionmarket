import { createHmac } from 'node:crypto'
import { z } from 'zod'
import type { Environment } from '../../config/env.js'
import { AppError } from '../../utils/errors.js'
import type { OnSwitchPaymentRepository, PaymentOperationInput, PaymentQuoteInput } from './repository.js'
import type { PaymentOperationType } from './payments.js'

const idempotencyKeySchema = z
  .string()
  .min(16)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/)

export class OnSwitchPaymentsService {
  constructor(
    private readonly repository: OnSwitchPaymentRepository,
    private readonly environment: Environment,
  ) {}

  async createQuote(
    userId: string,
    operationType: PaymentOperationType,
    quote: Omit<PaymentQuoteInput, 'userId' | 'operationType' | 'requestFingerprint'>,
    fingerprintMaterial: Record<string, unknown>,
  ): Promise<{ id: string; expiresAt: Date }> {
    this.assertFingerprintSecret()
    if (quote.expiresAt.getTime() <= Date.now())
      throw new AppError('PAYMENT_QUOTE_EXPIRED', 'Payment quote is already expired', 400)
    const requestFingerprint = this.fingerprint({ ...fingerprintMaterial, operationType })
    const id = await this.repository.createQuote({
      userId,
      operationType,
      requestFingerprint,
      ...quote,
    })
    return { id, expiresAt: quote.expiresAt }
  }

  async createOperation(
    userId: string,
    idempotencyKey: string,
    input: Omit<PaymentOperationInput, 'userId' | 'idempotencyKey' | 'requestFingerprint'>,
    fingerprintMaterial: Record<string, unknown>,
  ): Promise<{ id: string; existing: boolean }> {
    this.assertFingerprintSecret()
    const key = idempotencyKeySchema.safeParse(idempotencyKey)
    if (!key.success)
      throw new AppError('IDEMPOTENCY_KEY_INVALID', 'A valid idempotency key is required', 400)
    const requestFingerprint = this.fingerprint({
      ...fingerprintMaterial,
      operationType: input.operationType,
    })
    return this.repository.createOperation({
      ...input,
      userId,
      idempotencyKey: key.data,
      requestFingerprint,
    })
  }

  async findOperationReplay(
    userId: string,
    idempotencyKey: string,
    operationType: PaymentOperationType,
    fingerprintMaterial: Record<string, unknown>,
  ): Promise<{ id: string } | null> {
    this.assertFingerprintSecret()
    const key = idempotencyKeySchema.safeParse(idempotencyKey)
    if (!key.success)
      throw new AppError('IDEMPOTENCY_KEY_INVALID', 'A valid idempotency key is required', 400)
    const existing = await this.repository.findOperationByIdempotency(userId, key.data)
    if (!existing) return null
    const requestFingerprint = this.fingerprint({ ...fingerprintMaterial, operationType })
    if (existing.requestFingerprint !== requestFingerprint)
      throw new AppError('IDEMPOTENCY_CONFLICT', 'Idempotency key was used for another payment request', 409)
    return { id: existing.id }
  }

  private fingerprint(value: unknown): string {
    return createHmac('sha256', this.environment.ONSWITCH_IDEMPOTENCY_SECRET!)
      .update(canonicalJson(value))
      .digest('hex')
  }

  private assertFingerprintSecret(): void {
    if (!this.environment.ONSWITCH_IDEMPOTENCY_SECRET)
      throw new AppError('PAYMENTS_UNAVAILABLE', 'Payment operations are not configured', 503)
  }
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`
}
