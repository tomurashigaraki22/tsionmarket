import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { OnSwitchRuntimeConfig } from '../../config/onswitch.js'
import { increment } from '../../observability/metrics.js'
import { AppError } from '../../utils/errors.js'
import type { OnSwitchPaymentRepository } from './repository.js'

const webhookSchema = z.object({
  success: z.literal(true),
  data: z.object({
    reference: z.string().uuid(),
    type: z.enum(['ONRAMP', 'OFFRAMP']),
    status: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[A-Za-z_]+$/),
  }),
})

export class OnSwitchWebhookService {
  constructor(
    private readonly config: OnSwitchRuntimeConfig | null,
    private readonly repository: Pick<OnSwitchPaymentRepository, 'storeVerifiedWebhook'>,
  ) {}

  async receive(rawBody: Buffer, signature: string | undefined, deliveryTimestamp: string | undefined) {
    if (!this.config) throw new AppError('PAYMENTS_UNAVAILABLE', 'Payment callbacks are not enabled', 503)
    if (!Buffer.isBuffer(rawBody) || rawBody.length === 0 || rawBody.length > 128 * 1024)
      throw new AppError('WEBHOOK_INVALID_BODY', 'Webhook body is invalid', 400)
    if (!signature || !/^[a-f0-9]{64}$/i.test(signature.trim())) {
      increment('onswitch_webhook_signature_failures_total')
      throw new AppError('WEBHOOK_SIGNATURE_INVALID', 'Webhook signature is invalid', 401)
    }

    const expected = createHmac('sha256', this.config.serviceKey).update(rawBody).digest()
    const provided = Buffer.from(signature.trim(), 'hex')
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      increment('onswitch_webhook_signature_failures_total')
      throw new AppError('WEBHOOK_SIGNATURE_INVALID', 'Webhook signature is invalid', 401)
    }

    let payload: unknown
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as unknown
    } catch {
      throw new AppError('WEBHOOK_INVALID_BODY', 'Webhook body is invalid', 400)
    }
    const parsed = webhookSchema.safeParse(payload)
    if (!parsed.success) throw new AppError('WEBHOOK_INVALID_BODY', 'Webhook event is invalid', 400)

    // Switch's timestamp header is not part of the documented signed message.
    // Keep only a short bounded value for diagnostics; event-digest uniqueness
    // is the replay defense, so an unsigned timestamp is never trusted.
    const safeTimestamp =
      deliveryTimestamp && deliveryTimestamp.length <= 80 && /^[0-9T:Z+\-. ]+$/.test(deliveryTimestamp)
        ? deliveryTimestamp
        : null
    const result = await this.repository.storeVerifiedWebhook({
      eventDigest: createHash('sha256').update(rawBody).digest('hex'),
      providerReference: parsed.data.data.reference,
      providerType: parsed.data.data.type,
      providerStatus: parsed.data.data.status.toUpperCase(),
      deliveryTimestamp: safeTimestamp,
    })
    increment(result.duplicate ? 'onswitch_webhook_replays_total' : 'onswitch_webhook_events_accepted_total')
    return { accepted: true, duplicate: result.duplicate }
  }
}
