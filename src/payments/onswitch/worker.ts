import { z } from 'zod'
import type { Environment } from '../../config/env.js'
import { increment } from '../../observability/metrics.js'
import { logger } from '../../utils/logger.js'
import { OnSwitchClientError } from './client.js'
import type { OnSwitchClient } from './client.js'
import { retryDelayMs } from './repository.js'
import type { OnSwitchPaymentRepository } from './repository.js'

const statusResponseSchema = z.object({
  reference: z.string().uuid(),
  status: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[A-Za-z_]+$/),
})

export class OnSwitchWorker {
  private timer: NodeJS.Timeout | undefined
  private running = false

  constructor(
    private readonly repository: OnSwitchPaymentRepository,
    private readonly client: OnSwitchClient,
    private readonly environment: Environment,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(): void {
    if (!this.environment.ONSWITCH_ENABLED || this.timer) return
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.environment.ONSWITCH_WORKER_INTERVAL_SECONDS * 1000)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  async tick(): Promise<void> {
    if (this.running || !this.environment.ONSWITCH_ENABLED) return
    this.running = true
    try {
      const webhookCount = await this.repository.processWebhookBatch(
        this.environment.ONSWITCH_WORKER_BATCH_SIZE,
        this.environment.ONSWITCH_WORKER_MAX_ATTEMPTS,
        this.environment.ONSWITCH_WORKER_LOCK_SECONDS,
      )
      increment('onswitch_webhook_events_processed_total', webhookCount)
      await this.confirmDueOperations()
      await this.reconcileDueOperations()
    } catch (error) {
      logger.warn('OnSwitch worker tick failed', {
        errorCode: workerErrorCode(error),
      })
    } finally {
      this.running = false
    }
  }

  private async confirmDueOperations(): Promise<void> {
    const records = await this.repository.claimConfirmationBatch(
      this.environment.ONSWITCH_WORKER_BATCH_SIZE,
      this.environment.ONSWITCH_WORKER_LOCK_SECONDS,
    )
    for (const record of records) {
      const attempt = record.attempts + 1
      try {
        const response = await this.client.post('/payment/confirm', {
          reference: record.providerReference,
          hash: record.chainTxHash,
        })
        const status = providerStatusSchema.safeParse(response.data)
        await this.repository.recordConfirmationAttempt({
          operationId: record.operationId,
          acknowledged: true,
          attempt,
          retryAt: null,
          ...(status.success ? { providerStatus: status.data.status } : {}),
          maxAttempts: this.environment.ONSWITCH_WORKER_MAX_ATTEMPTS,
        })
      } catch (error) {
        const retryAt =
          attempt >= this.environment.ONSWITCH_WORKER_MAX_ATTEMPTS
            ? null
            : new Date(this.now().getTime() + retryDelayMs(attempt))
        await this.repository.recordConfirmationAttempt({
          operationId: record.operationId,
          acknowledged: false,
          attempt,
          retryAt,
          failureCode: workerErrorCode(error),
          maxAttempts: this.environment.ONSWITCH_WORKER_MAX_ATTEMPTS,
        })
        increment('onswitch_confirm_failures_total')
      }
    }
  }

  private async reconcileDueOperations(): Promise<void> {
    const records = await this.repository.claimReconciliationBatch(
      this.environment.ONSWITCH_WORKER_BATCH_SIZE,
      this.environment.ONSWITCH_WORKER_LOCK_SECONDS,
    )
    for (const record of records) {
      const attempt = record.attempts + 1
      try {
        const response = await this.client.get('/payment/status', { reference: record.providerReference })
        const status = statusResponseSchema.safeParse(response.data)
        if (!status.success || status.data.reference !== record.providerReference)
          throw new Error('INVALID_PROVIDER_STATUS')
        await this.repository.recordReconciliation({
          operationId: record.operationId,
          providerStatus: status.data.status,
          attempt,
          maxAttempts: this.environment.ONSWITCH_WORKER_MAX_ATTEMPTS,
          retryAt: new Date(this.now().getTime() + retryDelayMs(attempt)),
        })
        increment('onswitch_reconciliations_total')
      } catch (error) {
        await this.repository.recordReconciliation({
          operationId: record.operationId,
          attempt,
          maxAttempts: this.environment.ONSWITCH_WORKER_MAX_ATTEMPTS,
          retryAt: new Date(this.now().getTime() + retryDelayMs(attempt)),
          failureCode: workerErrorCode(error),
        })
        increment('onswitch_reconciliation_failures_total')
      }
    }
  }
}

function workerErrorCode(error: unknown): string {
  return error instanceof OnSwitchClientError ? error.code : 'WORKER_ERROR'
}

const providerStatusSchema = z
  .object({
    status: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[A-Za-z_]+$/),
  })
  .passthrough()
