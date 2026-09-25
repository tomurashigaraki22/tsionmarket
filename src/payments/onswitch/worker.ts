import { z } from 'zod'
import type { Environment } from '../../config/env.js'
import { increment, setGauge } from '../../observability/metrics.js'
import { logger } from '../../utils/logger.js'
import { OnSwitchClientError } from './client.js'
import type { OnSwitchClient } from './client.js'
import { retryDelayMs } from './repository.js'
import type { OnSwitchPaymentRepository } from './repository.js'
import { normalizePaymentStatusSnapshot } from './journeys.js'

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
      setGauge('onswitch_onramp_starts_enabled', this.environment.ONSWITCH_ONRAMP_STARTS_ENABLED ? 1 : 0)
      setGauge('onswitch_offramp_starts_enabled', this.environment.ONSWITCH_OFFRAMP_STARTS_ENABLED ? 1 : 0)
      const webhookCount = await this.repository.processWebhookBatch(
        this.environment.ONSWITCH_WORKER_BATCH_SIZE,
        this.environment.ONSWITCH_WORKER_MAX_ATTEMPTS,
        this.environment.ONSWITCH_WORKER_LOCK_SECONDS,
      )
      increment('onswitch_webhook_events_processed_total', webhookCount)
      await this.linkConfirmedTransferIntents()
      await this.confirmDueOperations()
      await this.reconcileDueOperations()
      if (typeof this.repository.operationalSnapshot === 'function') {
        try {
          const snapshot = await this.repository.operationalSnapshot()
          setGauge('onswitch_pending_operations', snapshot.pendingOperations)
          setGauge('onswitch_manual_review_operations', snapshot.manualReviewOperations)
          setGauge('onswitch_webhook_backlog', snapshot.webhookBacklog)
          setGauge('onswitch_oldest_pending_age_seconds', snapshot.oldestPendingAgeSeconds)
        } catch {
          increment('onswitch_operational_snapshot_failures_total')
        }
      }
    } catch (error) {
      increment('onswitch_worker_tick_failures_total')
      logger.warn('OnSwitch worker tick failed', {
        errorCode: workerErrorCode(error),
      })
    } finally {
      this.running = false
    }
  }

  private async linkConfirmedTransferIntents(): Promise<void> {
    const links = await this.repository.findConfirmedTransferLinks(
      this.environment.ONSWITCH_WORKER_BATCH_SIZE,
    )
    for (const link of links) {
      try {
        await this.repository.linkConfirmedChainTransaction(
          link.userId,
          link.paymentId,
          link.transactionRecordId,
        )
      } catch (error) {
        logger.warn('OnSwitch confirmed wallet transfer could not be linked', {
          paymentId: link.paymentId,
          errorCode: workerErrorCode(error),
        })
      }
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
        const payment = await this.repository.getForWorker(record.operationId)
        if (!payment) throw new Error('PAYMENT_REFERENCE_MISSING')
        const snapshot = normalizePaymentStatusSnapshot(response.data, payment.operationType, payment.terms)
        const needsDepositInstructions =
          status.data.status.toUpperCase() === 'AWAITING_DEPOSIT' && !payment.instructions && !snapshot
        await this.repository.recordReconciliation({
          operationId: record.operationId,
          ...(needsDepositInstructions ? {} : { providerStatus: status.data.status }),
          attempt,
          maxAttempts: this.environment.ONSWITCH_WORKER_MAX_ATTEMPTS,
          retryAt: new Date(this.now().getTime() + retryDelayMs(attempt)),
          ...(snapshot ?? {}),
          ...(needsDepositInstructions ? { failureCode: 'STATUS_DETAILS_INVALID' } : {}),
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
