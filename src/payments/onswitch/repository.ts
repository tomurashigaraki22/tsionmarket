import { randomUUID } from 'node:crypto'
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { withTransaction } from '../../db/transaction.js'
import { fromMysqlDateTime } from '../../db/datetime.js'
import { AppError } from '../../utils/errors.js'
import {
  canTransitionPayment,
  isPaymentTerminal,
  normalizeProviderStatus,
  type PaymentOperationType,
  type PaymentStatus,
} from './payments.js'

export type PaymentOperationInput = {
  userId: string
  operationType: PaymentOperationType
  idempotencyKey: string
  requestFingerprint: string
  accountId?: string | undefined
  networkId?: string | undefined
  quoteId?: string | undefined
  beneficiaryRefId?: string | undefined
  country?: string | undefined
  fiatCurrency?: string | undefined
  channel?: string | undefined
  assetKey?: string | undefined
  sourceAmount?: string | undefined
  destinationAmount?: string | undefined
  termsSnapshot?: Record<string, unknown> | undefined
  expiresAt?: Date | undefined
}

export type PaymentQuoteInput = {
  userId: string
  operationType: PaymentOperationType
  requestFingerprint: string
  country?: string | undefined
  fiatCurrency?: string | undefined
  channel?: string | undefined
  assetKey?: string | undefined
  sourceAmount?: string | undefined
  destinationAmount?: string | undefined
  rate?: string | undefined
  feeAmount?: string | undefined
  termsSnapshot: Record<string, unknown>
  expiresAt: Date
}

export type CachedCatalogue = { payload: unknown; fetchedAt: Date; expiresAt: Date }
export type ProviderBeneficiaryReference = {
  id: string
  providerBeneficiaryId: string
  country: string | null
  fiatCurrency: string | null
  channel: string | null
  holderType: string | null
  maskedLabel: string
  createdAt: Date
}

type OperationRow = RowDataPacket & {
  id: string
  userId: string
  operationType: PaymentOperationType
  status: PaymentStatus
  providerReference: string | null
  requestFingerprint: string
  providerStatus: string | null
  reconcileAttempts: number
  createdAt: string | Date
  updatedAt: string | Date
  expiresAt: string | Date | null
  termsSnapshot: unknown
  safeInstructions: unknown
  country: string | null
  fiatCurrency: string | null
  channel: string | null
  assetKey: string | null
  sourceAmount: string | null
  destinationAmount: string | null
  chainTxHash: string | null
  accountId: string | null
  networkId: string | null
}

type PaymentQuoteRow = RowDataPacket & {
  operationType: PaymentOperationType
  expiresAt: string | Date
  consumedAt: string | Date | null
}

type CatalogueCacheRow = RowDataPacket & {
  payload: unknown
  fetchedAt: string | Date
  expiresAt: string | Date
}

type BeneficiaryReferenceRow = RowDataPacket & {
  id: string
  providerBeneficiaryId: string
  country: string | null
  fiatCurrency: string | null
  channel: string | null
  holderType: string | null
  maskedLabel: string
  createdAt: string | Date
}

type ClaimedWork = {
  id: string
  operationId: string
  providerReference: string
  providerStatus?: string
  chainTxHash?: string
  attempts: number
}

const decodeJson = (value: unknown): unknown => (typeof value === 'string' ? JSON.parse(value) : value)
const asDate = (value: string | Date | null): Date | null =>
  value === null ? null : fromMysqlDateTime(value)

function mapOperation(row: OperationRow) {
  return {
    id: row.id,
    operationType: row.operationType,
    status: row.status,
    providerReference: row.providerReference,
    providerStatus: row.providerStatus,
    country: row.country,
    fiatCurrency: row.fiatCurrency,
    channel: row.channel,
    assetKey: row.assetKey,
    sourceAmount: row.sourceAmount,
    destinationAmount: row.destinationAmount,
    accountId: row.accountId,
    networkId: row.networkId,
    chainTxHash: row.chainTxHash,
    terms: decodeJson(row.termsSnapshot),
    instructions: decodeJson(row.safeInstructions),
    expiresAt: asDate(row.expiresAt),
    createdAt: fromMysqlDateTime(row.createdAt),
    updatedAt: fromMysqlDateTime(row.updatedAt),
  }
}

export class OnSwitchPaymentRepository {
  constructor(private readonly pool: Pool) {}

  async createQuote(input: PaymentQuoteInput): Promise<string> {
    const id = randomUUID()
    await this.pool.execute(
      `INSERT INTO payment_quotes
       (id,user_id,operation_type,request_fingerprint,country,fiat_currency,channel,asset_key,
        source_amount,destination_amount,rate,fee_amount,terms_snapshot,expires_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        input.userId,
        input.operationType,
        input.requestFingerprint,
        input.country ?? null,
        input.fiatCurrency ?? null,
        input.channel ?? null,
        input.assetKey ?? null,
        input.sourceAmount ?? null,
        input.destinationAmount ?? null,
        input.rate ?? null,
        input.feeAmount ?? null,
        JSON.stringify(input.termsSnapshot),
        input.expiresAt,
      ],
    )
    return id
  }

  async createOperation(input: PaymentOperationInput): Promise<{ id: string; existing: boolean }> {
    const id = randomUUID()
    try {
      return await withTransaction(this.pool, async (connection) => {
        const [replays] = await connection.execute<RowDataPacket[]>(
          `SELECT id,request_fingerprint AS requestFingerprint FROM payment_operations
           WHERE user_id=? AND idempotency_key=? FOR UPDATE`,
          [input.userId, input.idempotencyKey],
        )
        const replay = replays[0]
        if (replay) {
          if (replay.requestFingerprint !== input.requestFingerprint)
            throw new AppError(
              'IDEMPOTENCY_CONFLICT',
              'Idempotency key was used for another payment request',
              409,
            )
          return { id: String(replay.id), existing: true }
        }

        if (input.accountId) {
          const [accounts] = await connection.execute<RowDataPacket[]>(
            `SELECT network_id AS networkId FROM wallet_accounts
             WHERE id=? AND user_id=? AND status='active' AND ownership_status='verified' FOR UPDATE`,
            [input.accountId, input.userId],
          )
          const account = accounts[0]
          if (!account)
            throw new AppError('PAYMENT_ACCOUNT_UNAVAILABLE', 'Verified wallet account not found', 400)
          if (input.networkId && String(account.networkId) !== input.networkId)
            throw new AppError(
              'PAYMENT_NETWORK_MISMATCH',
              'Selected wallet does not belong to this network',
              400,
            )
        }

        if (input.quoteId) {
          const [quotes] = await connection.execute<PaymentQuoteRow[]>(
            `SELECT operation_type AS operationType,expires_at AS expiresAt,consumed_at AS consumedAt
             FROM payment_quotes WHERE id=? AND user_id=? FOR UPDATE`,
            [input.quoteId, input.userId],
          )
          const quote = quotes[0]
          if (!quote) throw new AppError('PAYMENT_QUOTE_NOT_FOUND', 'Payment quote not found', 404)
          if (String(quote.operationType) !== input.operationType)
            throw new AppError('PAYMENT_QUOTE_MISMATCH', 'Payment quote does not match this operation', 409)
          if (quote.consumedAt || fromMysqlDateTime(quote.expiresAt).getTime() <= Date.now())
            throw new AppError('PAYMENT_QUOTE_EXPIRED', 'Payment quote has expired or was already used', 409)
        }

        await connection.execute<ResultSetHeader>(
          `INSERT INTO payment_operations
           (id,user_id,quote_id,beneficiary_ref_id,account_id,network_id,operation_type,status,
            idempotency_key,request_fingerprint,country,fiat_currency,channel,asset_key,source_amount,
            destination_amount,terms_snapshot,expires_at,next_reconcile_at)
           VALUES(?,?,?,?,?,?,?,'created',?,?,?,?,?,?,?,?,?,?,DATE_ADD(NOW(6), INTERVAL 20 SECOND))`,
          [
            id,
            input.userId,
            input.quoteId ?? null,
            input.beneficiaryRefId ?? null,
            input.accountId ?? null,
            input.networkId ?? null,
            input.operationType,
            input.idempotencyKey,
            input.requestFingerprint,
            input.country ?? null,
            input.fiatCurrency ?? null,
            input.channel ?? null,
            input.assetKey ?? null,
            input.sourceAmount ?? null,
            input.destinationAmount ?? null,
            input.termsSnapshot ? JSON.stringify(input.termsSnapshot) : null,
            input.expiresAt ?? null,
          ],
        )
        await connection.execute(
          `INSERT INTO payment_state_transitions(payment_operation_id,from_status,to_status,source)
           VALUES(?,NULL,'created','local')`,
          [id],
        )
        if (input.quoteId)
          await connection.execute(
            'UPDATE payment_quotes SET consumed_at=NOW(6) WHERE id=? AND user_id=? AND consumed_at IS NULL',
            [input.quoteId, input.userId],
          )
        return { id, existing: false }
      })
    } catch (error) {
      if (!isDuplicateKey(error)) throw error
      const [rows] = await this.pool.execute<RowDataPacket[]>(
        `SELECT id,request_fingerprint AS requestFingerprint FROM payment_operations
         WHERE user_id=? AND idempotency_key=?`,
        [input.userId, input.idempotencyKey],
      )
      const existing = rows[0]
      if (!existing) throw error
      if (existing.requestFingerprint !== input.requestFingerprint)
        throw new AppError(
          'IDEMPOTENCY_CONFLICT',
          'Idempotency key was used for another payment request',
          409,
        )
      return { id: String(existing.id), existing: true }
    }
  }

  async setProviderReference(operationId: string, providerReference: string): Promise<void> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE payment_operations SET provider_reference=?,
       next_reconcile_at=COALESCE(next_reconcile_at,NOW(6)),
       next_confirmation_at=IF(chain_tx_hash IS NOT NULL AND confirmation_acknowledged_at IS NULL,NOW(6),next_confirmation_at)
       WHERE id=? AND provider='onswitch' AND (provider_reference IS NULL OR provider_reference=?)`,
      [providerReference, operationId, providerReference],
    )
    if (result.affectedRows !== 1) {
      const [rows] = await this.pool.execute<RowDataPacket[]>(
        'SELECT id FROM payment_operations WHERE id=? AND provider_reference=?',
        [operationId, providerReference],
      )
      if (rows[0]) return
      throw new AppError('PAYMENT_REFERENCE_CONFLICT', 'Provider reference cannot be changed', 409)
    }
  }

  async linkConfirmedChainTransaction(
    userId: string,
    paymentId: string,
    transactionRecordId: string,
  ): Promise<void> {
    await withTransaction(this.pool, async (connection) => {
      const [payments] = await connection.execute<RowDataPacket[]>(
        `SELECT status,account_id AS accountId,network_id AS networkId,chain_tx_hash AS chainTxHash,
                transaction_record_id AS transactionRecordId
         FROM payment_operations WHERE id=? AND user_id=? AND operation_type='offramp' FOR UPDATE`,
        [paymentId, userId],
      )
      const payment = payments[0]
      if (!payment) throw new AppError('PAYMENT_NOT_FOUND', 'Payment not found', 404)
      if (payment.transactionRecordId && String(payment.transactionRecordId) === transactionRecordId) return
      if (payment.chainTxHash || payment.transactionRecordId)
        throw new AppError(
          'PAYMENT_CHAIN_TRANSACTION_CONFLICT',
          'A different chain transfer is already linked',
          409,
        )
      if (!payment.accountId || !payment.networkId)
        throw new AppError('PAYMENT_ACCOUNT_UNAVAILABLE', 'Payment has no verified wallet account', 409)

      const [records] = await connection.execute<RowDataPacket[]>(
        `SELECT id,intent_id AS intentId,tx_hash AS txHash,account_id AS accountId,network_id AS networkId
         FROM transaction_records
         WHERE id=? AND user_id=? AND status='confirmed' AND account_id=? AND network_id=? FOR UPDATE`,
        [transactionRecordId, userId, payment.accountId, payment.networkId],
      )
      const record = records[0]
      if (!record)
        throw new AppError('PAYMENT_CHAIN_TX_NOT_CONFIRMED', 'Confirmed wallet transfer was not found', 409)

      const before = String(payment.status) as PaymentStatus
      if (before !== 'chain_submitted' && !canTransitionPayment(before, 'chain_submitted'))
        throw new AppError('PAYMENT_STATE_CONFLICT', 'Payment is not waiting for a chain transfer', 409)
      await connection.execute(
        `UPDATE payment_operations SET status='chain_submitted',chain_tx_hash=?,transaction_intent_id=?,
         transaction_record_id=?,next_confirmation_at=NOW(6),confirmation_attempts=0,
         confirmation_acknowledged_at=NULL,next_reconcile_at=NOW(6) WHERE id=?`,
        [record.txHash, record.intentId, record.id, paymentId],
      )
      if (before !== 'chain_submitted')
        await connection.execute(
          `INSERT INTO payment_state_transitions(payment_operation_id,from_status,to_status,source)
           VALUES(?,?,'chain_submitted','local')`,
          [paymentId, before],
        )
    })
  }

  async getForUser(userId: string, paymentId: string) {
    const [rows] = await this.pool.execute<OperationRow[]>(
      `${operationSelect} WHERE p.user_id=? AND p.id=?`,
      [userId, paymentId],
    )
    return rows[0] ? mapOperation(rows[0]) : null
  }

  async listForUser(userId: string, limit: number, cursor?: { createdAt: Date; id: string }) {
    const cursorClause = cursor ? 'AND (p.created_at < ? OR (p.created_at = ? AND p.id < ?))' : ''
    const params = cursor ? [userId, cursor.createdAt, cursor.createdAt, cursor.id, limit] : [userId, limit]
    const [rows] = await this.pool.execute<OperationRow[]>(
      `${operationSelect} WHERE p.user_id=? ${cursorClause}
       ORDER BY p.created_at DESC,p.id DESC LIMIT ?`,
      params,
    )
    return rows.map(mapOperation)
  }

  async storeVerifiedWebhook(input: {
    eventDigest: string
    providerReference: string
    providerType: string
    providerStatus: string
    deliveryTimestamp: string | null
  }): Promise<{ duplicate: boolean }> {
    const eventId = randomUUID()
    try {
      await withTransaction(this.pool, async (connection) => {
        const [operations] = await connection.execute<RowDataPacket[]>(
          `SELECT id,operation_type AS operationType FROM payment_operations
           WHERE provider='onswitch' AND provider_reference=?`,
          [input.providerReference],
        )
        const payment = operations[0]
        if (!payment) throw new AppError('PAYMENT_NOT_FOUND', 'Payment reference not found', 404)
        const expectedType = input.providerType === 'ONRAMP' ? 'onramp' : 'offramp'
        if (String(payment.operationType) !== expectedType)
          throw new AppError(
            'PAYMENT_WEBHOOK_TYPE_MISMATCH',
            'Payment callback type does not match its reference',
            409,
          )
        await connection.execute<ResultSetHeader>(
          `INSERT INTO onswitch_webhook_inbox
           (id,payment_operation_id,event_digest,provider_reference,provider_type,provider_status,delivery_timestamp,next_attempt_at)
           VALUES(?,?,?,?,?,?,?,NOW(6))`,
          [
            eventId,
            payment.id,
            input.eventDigest,
            input.providerReference,
            input.providerType,
            input.providerStatus,
            input.deliveryTimestamp,
          ],
        )
      })
      return { duplicate: false }
    } catch (error) {
      if (isDuplicateKey(error)) {
        const [rows] = await this.pool.execute<RowDataPacket[]>(
          'SELECT id FROM onswitch_webhook_inbox WHERE event_digest=?',
          [input.eventDigest],
        )
        if (rows[0]) return { duplicate: true }
      }
      throw error
    }
  }

  async processWebhookBatch(limit: number, maxAttempts: number, lockSeconds: number): Promise<number> {
    return withTransaction(this.pool, async (connection) => {
      const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT id,payment_operation_id AS paymentOperationId,provider_status AS providerStatus,
                event_digest AS eventDigest,attempts
         FROM onswitch_webhook_inbox
         WHERE (state='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=NOW(6)))
           AND (processing_lock_until IS NULL OR processing_lock_until<NOW(6))
         ORDER BY received_at ASC LIMIT ? FOR UPDATE SKIP LOCKED`,
        [limit],
      )
      for (const row of rows) {
        const eventId = String(row.id)
        const operationId = String(row.paymentOperationId)
        const attempts = Number(row.attempts) + 1
        await connection.execute(
          `UPDATE onswitch_webhook_inbox SET processing_lock_until=DATE_ADD(NOW(6), INTERVAL ? SECOND),attempts=? WHERE id=?`,
          [lockSeconds, attempts, eventId],
        )
        const [operations] = await connection.execute<RowDataPacket[]>(
          'SELECT status FROM payment_operations WHERE id=? FOR UPDATE',
          [operationId],
        )
        const current = operations[0]
        if (!current) {
          await this.failWebhook(connection, eventId, attempts, maxAttempts, 'PAYMENT_REFERENCE_MISSING')
          continue
        }
        const before = String(current.status) as PaymentStatus
        const next = mapProviderStatus(String(row.providerStatus))
        if (before !== next && canTransitionPayment(before, next)) {
          await connection.execute(
            `UPDATE payment_operations SET status=?,provider_status=?,reconcile_attempts=0,
             next_reconcile_at=?,completed_at=IF(?='completed',COALESCE(completed_at,NOW(6)),completed_at) WHERE id=?`,
            [
              next,
              String(row.providerStatus),
              isPaymentTerminal(next) ? null : new Date(Date.now() + 20_000),
              next,
              operationId,
            ],
          )
          await connection.execute(
            `INSERT INTO payment_state_transitions
             (payment_operation_id,from_status,to_status,source,provider_status,event_digest)
             VALUES(?,?,?,'webhook',?,?)`,
            [operationId, before, next, String(row.providerStatus), String(row.eventDigest)],
          )
        }
        await connection.execute(
          `UPDATE onswitch_webhook_inbox SET state='processed',processed_at=NOW(6),processing_lock_until=NULL,last_error_code=NULL WHERE id=?`,
          [eventId],
        )
      }
      return rows.length
    })
  }

  async claimReconciliationBatch(limit: number, lockSeconds: number): Promise<ClaimedWork[]> {
    return withTransaction(this.pool, async (connection) => {
      const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT id,provider_reference AS providerReference,reconcile_attempts AS attempts
         FROM payment_operations
         WHERE provider='onswitch' AND provider_reference IS NOT NULL
           AND status NOT IN ('completed','failed','expired','reversed','manual_review')
           AND next_reconcile_at<=NOW(6)
           AND (reconcile_lock_until IS NULL OR reconcile_lock_until<NOW(6))
         ORDER BY next_reconcile_at ASC LIMIT ? FOR UPDATE SKIP LOCKED`,
        [limit],
      )
      for (const row of rows) {
        await connection.execute(
          `UPDATE payment_operations SET reconcile_lock_until=DATE_ADD(NOW(6), INTERVAL ? SECOND) WHERE id=?`,
          [lockSeconds, row.id],
        )
      }
      return rows.map((row) => ({
        id: String(row.id),
        operationId: String(row.id),
        providerReference: String(row.providerReference),
        attempts: Number(row.attempts),
      }))
    })
  }

  async recordReconciliation(input: {
    operationId: string
    providerStatus?: string
    attempt: number
    maxAttempts: number
    retryAt: Date
    failureCode?: string
  }): Promise<void> {
    await withTransaction(this.pool, async (connection) => {
      const [rows] = await connection.execute<RowDataPacket[]>(
        'SELECT status FROM payment_operations WHERE id=? FOR UPDATE',
        [input.operationId],
      )
      const row = rows[0]
      if (!row) return
      const before = String(row.status) as PaymentStatus
      const providerStatus = input.providerStatus ?? null
      let next = providerStatus ? mapProviderStatus(providerStatus) : before
      if (input.attempt >= input.maxAttempts && !isPaymentTerminal(next)) next = 'manual_review'
      const changed = before !== next && canTransitionPayment(before, next)
      if (changed) {
        await connection.execute(
          `UPDATE payment_operations SET status=?,provider_status=COALESCE(?,provider_status),last_error_code=?,
           reconcile_attempts=?,next_reconcile_at=?,reconcile_lock_until=NULL,
           completed_at=IF(?='completed',COALESCE(completed_at,NOW(6)),completed_at) WHERE id=?`,
          [
            next,
            providerStatus,
            input.failureCode ?? null,
            input.attempt,
            isPaymentTerminal(next) ? null : input.retryAt,
            next,
            input.operationId,
          ],
        )
        await connection.execute(
          `INSERT INTO payment_state_transitions(payment_operation_id,from_status,to_status,source,provider_status)
           VALUES(?,?,?,'reconciliation',?)`,
          [input.operationId, before, next, providerStatus],
        )
      } else {
        await connection.execute(
          `UPDATE payment_operations SET provider_status=COALESCE(?,provider_status),last_error_code=?,reconcile_attempts=?,
           next_reconcile_at=?,reconcile_lock_until=NULL WHERE id=?`,
          [
            providerStatus,
            input.failureCode ?? null,
            input.attempt,
            isPaymentTerminal(before) ? null : input.retryAt,
            input.operationId,
          ],
        )
      }
    })
  }

  async claimConfirmationBatch(limit: number, lockSeconds: number): Promise<ClaimedWork[]> {
    return withTransaction(this.pool, async (connection) => {
      const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT id,provider_reference AS providerReference,chain_tx_hash AS chainTxHash,
                confirmation_attempts AS attempts
         FROM payment_operations
         WHERE provider='onswitch' AND operation_type='offramp' AND provider_reference IS NOT NULL
           AND chain_tx_hash IS NOT NULL AND confirmation_acknowledged_at IS NULL
           AND confirmation_attempts<65535 AND next_confirmation_at<=NOW(6)
           AND (confirmation_lock_until IS NULL OR confirmation_lock_until<NOW(6))
         ORDER BY next_confirmation_at ASC LIMIT ? FOR UPDATE SKIP LOCKED`,
        [limit],
      )
      for (const row of rows) {
        await connection.execute(
          `UPDATE payment_operations SET confirmation_lock_until=DATE_ADD(NOW(6), INTERVAL ? SECOND) WHERE id=?`,
          [lockSeconds, row.id],
        )
      }
      return rows.map((row) => ({
        id: String(row.id),
        operationId: String(row.id),
        providerReference: String(row.providerReference),
        chainTxHash: String(row.chainTxHash),
        attempts: Number(row.attempts),
      }))
    })
  }

  async recordConfirmationAttempt(input: {
    operationId: string
    acknowledged: boolean
    attempt: number
    retryAt: Date | null
    providerStatus?: string
    failureCode?: string
    maxAttempts: number
  }): Promise<void> {
    await withTransaction(this.pool, async (connection) => {
      const [rows] = await connection.execute<RowDataPacket[]>(
        'SELECT status FROM payment_operations WHERE id=? FOR UPDATE',
        [input.operationId],
      )
      const row = rows[0]
      if (!row) return
      if (input.acknowledged) {
        await connection.execute(
          `UPDATE payment_operations SET confirmation_attempts=?,confirmation_acknowledged_at=NOW(6),last_error_code=NULL,
           confirmation_lock_until=NULL,next_confirmation_at=NULL,provider_status=COALESCE(?,provider_status) WHERE id=?`,
          [input.attempt, input.providerStatus ?? null, input.operationId],
        )
      } else {
        const before = String(row.status) as PaymentStatus
        const needsReview = input.attempt >= input.maxAttempts && !isPaymentTerminal(before)
        await connection.execute(
          `UPDATE payment_operations SET confirmation_attempts=?,confirmation_lock_until=NULL,last_error_code=?,
           next_confirmation_at=?,provider_status=COALESCE(?,provider_status),status=? WHERE id=?`,
          [
            input.attempt,
            input.failureCode ?? null,
            needsReview ? null : input.retryAt,
            input.providerStatus ?? null,
            needsReview ? 'manual_review' : before,
            input.operationId,
          ],
        )
        if (needsReview && canTransitionPayment(before, 'manual_review'))
          await connection.execute(
            `INSERT INTO payment_state_transitions(payment_operation_id,from_status,to_status,source)
             VALUES(?,?,'manual_review','confirmation')`,
            [input.operationId, before],
          )
      }
    })
  }

  async getCatalogueCache(cacheKey: string): Promise<CachedCatalogue | null> {
    const [rows] = await this.pool.execute<CatalogueCacheRow[]>(
      'SELECT payload,fetched_at AS fetchedAt,expires_at AS expiresAt FROM onswitch_catalogue_cache WHERE cache_key=?',
      [cacheKey],
    )
    const row = rows[0]
    if (!row) return null
    return {
      payload: decodeJson(row.payload),
      fetchedAt: fromMysqlDateTime(row.fetchedAt),
      expiresAt: fromMysqlDateTime(row.expiresAt),
    }
  }

  async setCatalogueCache(cacheKey: string, payload: unknown, ttlSeconds: number): Promise<CachedCatalogue> {
    const fetchedAt = new Date()
    const expiresAt = new Date(fetchedAt.getTime() + ttlSeconds * 1000)
    const serialized = JSON.stringify(payload)
    await this.pool.execute(
      `INSERT INTO onswitch_catalogue_cache(cache_key,payload,fetched_at,expires_at)
       VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE payload=VALUES(payload),fetched_at=VALUES(fetched_at),expires_at=VALUES(expires_at)`,
      [cacheKey, serialized, fetchedAt, expiresAt],
    )
    return { payload, fetchedAt, expiresAt }
  }

  async verifiedEnabledNetworks(userId: string): Promise<string[]> {
    const [rows] = await this.pool.execute<(RowDataPacket & { networkId: string })[]>(
      `SELECT DISTINCT n.network_id AS networkId FROM networks n
       JOIN wallet_accounts a ON a.network_id=n.network_id
       WHERE a.user_id=? AND a.status='active' AND a.ownership_status='verified' AND n.enabled=TRUE`,
      [userId],
    )
    return rows.map((row) => String(row.networkId))
  }

  async saveBeneficiaryReference(input: {
    userId: string
    providerBeneficiaryId: string
    country?: string | undefined
    fiatCurrency?: string | undefined
    channel?: string | undefined
    holderType?: string | undefined
    maskedLabel: string
  }): Promise<string> {
    const id = randomUUID()
    try {
      await this.pool.execute(
        `INSERT INTO payment_beneficiary_refs
         (id,user_id,provider,provider_beneficiary_id,country,fiat_currency,channel,holder_type,masked_label)
         VALUES(?,?,'onswitch',?,?,?,?,?,?)`,
        [
          id,
          input.userId,
          input.providerBeneficiaryId,
          input.country ?? null,
          input.fiatCurrency ?? null,
          input.channel ?? null,
          input.holderType ?? null,
          input.maskedLabel.slice(0, 120),
        ],
      )
      return id
    } catch (error) {
      if (!isDuplicateKey(error)) throw error
      const [rows] = await this.pool.execute<RowDataPacket[]>(
        `SELECT id FROM payment_beneficiary_refs
         WHERE user_id=? AND provider='onswitch' AND provider_beneficiary_id=?`,
        [input.userId, input.providerBeneficiaryId],
      )
      const row = rows[0]
      if (!row)
        throw new AppError('BENEFICIARY_REFERENCE_CONFLICT', 'Beneficiary reference is already in use', 409)
      return String(row.id)
    }
  }

  async listBeneficiaryReferences(userId: string): Promise<ProviderBeneficiaryReference[]> {
    const [rows] = await this.pool.execute<BeneficiaryReferenceRow[]>(
      `SELECT id,provider_beneficiary_id AS providerBeneficiaryId,country,
       fiat_currency AS fiatCurrency,channel,holder_type AS holderType,masked_label AS maskedLabel,created_at AS createdAt
       FROM payment_beneficiary_refs WHERE user_id=? AND provider='onswitch' ORDER BY created_at DESC LIMIT 100`,
      [userId],
    )
    return rows.map((row) => ({
      id: String(row.id),
      providerBeneficiaryId: String(row.providerBeneficiaryId),
      country: row.country === null ? null : String(row.country),
      fiatCurrency: row.fiatCurrency === null ? null : String(row.fiatCurrency),
      channel: row.channel === null ? null : String(row.channel),
      holderType: row.holderType === null ? null : String(row.holderType),
      maskedLabel: String(row.maskedLabel),
      createdAt: fromMysqlDateTime(row.createdAt),
    }))
  }

  private async failWebhook(
    connection: PoolConnection,
    eventId: string,
    attempts: number,
    maxAttempts: number,
    code: string,
  ) {
    await connection.execute(
      `UPDATE onswitch_webhook_inbox SET state=?,last_error_code=?,processing_lock_until=NULL,
       next_attempt_at=?,processed_at=? WHERE id=?`,
      [
        attempts >= maxAttempts ? 'manual_review' : 'pending',
        code,
        attempts >= maxAttempts ? null : new Date(Date.now() + retryDelayMs(attempts)),
        attempts >= maxAttempts ? new Date() : null,
        eventId,
      ],
    )
  }
}

const operationSelect = `SELECT p.id,p.user_id AS userId,p.operation_type AS operationType,p.status,
  p.provider_reference AS providerReference,p.provider_status AS providerStatus,
  p.reconcile_attempts AS reconcileAttempts,p.created_at AS createdAt,p.updated_at AS updatedAt,
  p.expires_at AS expiresAt,p.terms_snapshot AS termsSnapshot,p.safe_instructions AS safeInstructions,
  p.country,p.fiat_currency AS fiatCurrency,p.channel,p.asset_key AS assetKey,
  CAST(p.source_amount AS CHAR) AS sourceAmount,CAST(p.destination_amount AS CHAR) AS destinationAmount,
  p.chain_tx_hash AS chainTxHash,p.account_id AS accountId,p.network_id AS networkId FROM payment_operations p`

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ER_DUP_ENTRY'
}

export function retryDelayMs(attempt: number, baseMs = 10_000, ceilingMs = 30 * 60_000): number {
  return Math.min(baseMs * 2 ** Math.max(0, attempt - 1), ceilingMs)
}

function mapProviderStatus(value: string): PaymentStatus {
  return normalizeProviderStatus(value)
}
