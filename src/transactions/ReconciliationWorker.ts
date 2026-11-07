/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- direct SQL reconciliation rows */
import type { Environment } from '../config/env.js'
import { NETWORKS } from '../portfolio/networks.js'
import type { RpcManager } from '../portfolio/RpcManager.js'
import { logger } from '../utils/logger.js'
import { increment } from '../observability/metrics.js'
import type { TransactionRepository } from './TransactionRepository.js'

export class ReconciliationWorker {
  private timer?: NodeJS.Timeout
  private running = false
  constructor(
    private repo: TransactionRepository,
    private rpc: RpcManager,
    private env: Environment,
    /** Called with the user whose transaction just settled on chain. */
    private onSettled?: (userId: string) => void,
  ) {}
  start() {
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.env.TRANSACTION_RECONCILE_INTERVAL_SECONDS * 1000)
    this.timer.unref()
  }
  stop() {
    if (this.timer) clearInterval(this.timer)
  }
  private async tick() {
    if (this.running) return
    this.running = true
    try {
      const records = await this.repo.reconciliationBatch(
        this.env.TRANSACTION_RECONCILE_BATCH_SIZE,
        this.env.TRANSACTION_RECONCILE_MAX_ATTEMPTS,
      )
      increment('reconciliation_batch_items_total', records.length)
      for (const record of records)
        await this.one(record).catch((error) =>
          logger.warn('Transaction reconciliation item failed', {
            recordId: record.id,
            error: error instanceof Error ? error.message : String(error),
          }),
        )
    } finally {
      this.running = false
    }
  }
  private async settle(
    record: any,
    status: 'submitted' | 'confirmed' | 'failed' | 'dropped' | 'unknown',
    attempt: number,
    max: number,
    detail?: string,
  ) {
    const final = await this.repo.reconcile(record.id, status, attempt, max, detail)
    // Confirmed or failed, the wallet's balance has just moved (a failed
    // transaction still burns its fee). Pending states change nothing.
    if ((final === 'confirmed' || final === 'failed') && typeof record.userId === 'string')
      this.onSettled?.(record.userId)
  }
  private async one(record: any) {
    const network = NETWORKS.find((item) => item.networkId === record.networkId),
      attempt = Number(record.attempts) + 1
    if (!network) {
      await this.settle(
        record,
        'unknown',
        attempt,
        this.env.TRANSACTION_RECONCILE_MAX_ATTEMPTS,
        'Network unavailable',
      )
      return
    }
    try {
      if (record.chainFamily === 'evm') {
        const client = this.rpc.evmClient(network)
        try {
          const receipt = await client.getTransactionReceipt({ hash: record.txHash })
          await this.settle(
            record,
            receipt.status === 'success' ? 'confirmed' : 'failed',
            attempt,
            this.env.TRANSACTION_RECONCILE_MAX_ATTEMPTS,
            receipt.status === 'reverted' ? 'EVM transaction reverted' : undefined,
          )
        } catch {
          try {
            await client.getTransaction({ hash: record.txHash })
            await this.settle(record, 'submitted', attempt, this.env.TRANSACTION_RECONCILE_MAX_ATTEMPTS)
          } catch {
            const old = Date.now() - new Date(record.createdAt).getTime() > 30 * 60_000
            await this.settle(
              record,
              old ? 'dropped' : 'unknown',
              attempt,
              this.env.TRANSACTION_RECONCILE_MAX_ATTEMPTS,
              old ? 'Transaction not found after 30 minutes' : 'RPC has not indexed transaction',
            )
          }
        }
        return
      }
      if (record.chainFamily === 'intertrain') {
        const response = await this.rpc.intertrainRequest(network, 'transaction_status', {
          hash: record.txHash,
        })
        const candidateStatus = (response as { status?: unknown })?.status
        const status = typeof candidateStatus === 'string' ? candidateStatus.toLowerCase() : ''
        if (status === 'confirmed' || status === 'finalized') {
          await this.settle(record, 'confirmed', attempt, this.env.TRANSACTION_RECONCILE_MAX_ATTEMPTS)
          return
        }
        if (status === 'failed' || status === 'reverted') {
          await this.settle(
            record,
            'failed',
            attempt,
            this.env.TRANSACTION_RECONCILE_MAX_ATTEMPTS,
            `Intertrain transaction ${status}`,
          )
          return
        }
        if (status === 'pending' || status === 'accepted') {
          await this.settle(record, 'submitted', attempt, this.env.TRANSACTION_RECONCILE_MAX_ATTEMPTS)
          return
        }
        const old = Date.now() - new Date(record.createdAt).getTime() > 30 * 60_000
        await this.settle(
          record,
          old ? 'dropped' : 'unknown',
          attempt,
          this.env.TRANSACTION_RECONCILE_MAX_ATTEMPTS,
          old
            ? 'Intertrain transaction not found after 30 minutes'
            : 'Intertrain RPC has not indexed transaction',
        )
        return
      }
      const statuses = await this.rpc.solana(network, (connection) =>
          connection.getSignatureStatuses([record.txHash], { searchTransactionHistory: true }),
        ),
        value = statuses.value[0]
      if (!value) {
        await this.settle(
          record,
          'unknown',
          attempt,
          this.env.TRANSACTION_RECONCILE_MAX_ATTEMPTS,
          'Signature not found',
        )
        return
      }
      if (value.err) {
        await this.settle(
          record,
          'failed',
          attempt,
          this.env.TRANSACTION_RECONCILE_MAX_ATTEMPTS,
          JSON.stringify(value.err),
        )
        return
      }
      await this.settle(
        record,
        value.confirmationStatus === 'finalized' ? 'confirmed' : 'submitted',
        attempt,
        this.env.TRANSACTION_RECONCILE_MAX_ATTEMPTS,
      )
    } catch (error) {
      await this.settle(
        record,
        'unknown',
        attempt,
        this.env.TRANSACTION_RECONCILE_MAX_ATTEMPTS,
        error instanceof Error ? error.message : String(error),
      )
    }
  }
}
