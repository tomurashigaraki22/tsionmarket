/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access -- mysql2 JSON/date values are normalized at this boundary */
import { randomUUID } from 'node:crypto'
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import { AppError } from '../utils/errors.js'

export type StoredIntent = {
  id: string
  userId: string
  accountId: string
  quoteId: string | null
  chainFamily: 'evm' | 'solana'
  networkId: string
  status: string
  unsignedTransaction: Record<string, unknown>
  normalizedSummary: Record<string, unknown>
  payloadHash: string
  expiresAt: Date
  address: string
  chainId: number | null
}
const json = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value)
export class TransactionRepository {
  constructor(private pool: Pool) {}
  async intent(userId: string, id: string): Promise<StoredIntent | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT i.id,i.user_id AS userId,i.account_id AS accountId,i.quote_id AS quoteId,i.chain_family AS chainFamily,i.network_id AS networkId,i.status,i.unsigned_transaction AS unsignedTransaction,i.normalized_summary AS normalizedSummary,i.payload_hash AS payloadHash,i.expires_at AS expiresAt,a.address,n.chain_id AS chainId FROM transaction_intents i JOIN wallet_accounts a ON a.id=i.account_id AND a.user_id=i.user_id JOIN networks n ON n.network_id=i.network_id WHERE i.id=? AND i.user_id=?`,
      [id, userId],
    )
    const row = rows[0]
    if (!row) return null
    return {
      ...(row as unknown as StoredIntent),
      unsignedTransaction: json(row.unsignedTransaction),
      normalizedSummary: json(row.normalizedSummary),
      expiresAt: new Date(row.expiresAt),
    }
  }
  async recordForIntent(userId: string, intentId: string) {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT id,intent_id AS intentId,quote_id AS quoteId,chain_family AS chainFamily,network_id AS networkId,tx_hash AS txHash,status,from_address AS fromAddress,to_address AS toAddress,summary,provider,failure_code AS failureCode,submitted_at AS submittedAt,confirmed_at AS confirmedAt,created_at AS createdAt,updated_at AS updatedAt FROM transaction_records WHERE user_id=? AND intent_id=?`,
      [userId, intentId],
    )
    return rows[0] ?? null
  }
  async claim(
    intent: StoredIntent,
    txHash: string,
    signedHash: string,
  ): Promise<{ id: string; claimed: boolean }> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [result] = await connection.execute<any>(
        `UPDATE transaction_intents SET status='broadcasting',version=version+1 WHERE id=? AND user_id=? AND status IN ('awaiting_signature','awaiting_approval') AND expires_at>NOW(6)`,
        [intent.id, intent.userId],
      )
      if (result.affectedRows !== 1) {
        const existing = await this.recordUsing(connection, intent.userId, intent.id)
        if (existing) {
          await connection.commit()
          return { id: String(existing.id), claimed: false }
        }
        throw new AppError('INTENT_NOT_SUBMITTABLE', 'Intent is no longer submittable', 409)
      }
      const id = randomUUID(),
        summary = intent.normalizedSummary,
        to = typeof summary.to === 'string' ? summary.to : null
      await connection.execute(
        `INSERT INTO transaction_records(id,intent_id,quote_id,user_id,account_id,chain_family,network_id,tx_hash,status,from_address,to_address,signed_payload_hash,summary,provider,next_reconcile_at) VALUES(?,?,?,?,?,?,?,?, 'broadcasting',?,?,?,?, 'lifi',NOW(6))`,
        [
          id,
          intent.id,
          intent.quoteId,
          intent.userId,
          intent.accountId,
          intent.chainFamily,
          intent.networkId,
          txHash,
          intent.address,
          to,
          signedHash,
          JSON.stringify(summary),
        ],
      )
      await connection.commit()
      return { id, claimed: true }
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }
  private async recordUsing(connection: PoolConnection, userId: string, intentId: string) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT id FROM transaction_records WHERE user_id=? AND intent_id=?`,
      [userId, intentId],
    )
    return rows[0]
  }
  async markBroadcast(recordId: string) {
    await this.pool.execute(
      `UPDATE transaction_records r JOIN transaction_intents i ON i.id=r.intent_id SET r.status='submitted',r.submitted_at=NOW(6),r.next_reconcile_at=NOW(6),i.status='submitted' WHERE r.id=? AND r.status='broadcasting'`,
      [recordId],
    )
  }
  async markBroadcastUnknown(recordId: string, detail: string) {
    await this.pool.execute(
      `UPDATE transaction_records r JOIN transaction_intents i ON i.id=r.intent_id SET r.status='unknown',r.failure_code='BROADCAST_RESULT_UNKNOWN',r.failure_detail=?,r.next_reconcile_at=DATE_ADD(NOW(6),INTERVAL 15 SECOND),i.status='unknown' WHERE r.id=? AND r.status='broadcasting'`,
      [detail.slice(0, 500), recordId],
    )
  }
  async get(userId: string, id: string) {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT id,intent_id AS intentId,quote_id AS quoteId,chain_family AS chainFamily,network_id AS networkId,tx_hash AS txHash,status,from_address AS fromAddress,to_address AS toAddress,summary,provider,failure_code AS failureCode,submitted_at AS submittedAt,confirmed_at AS confirmedAt,finalized_at AS finalizedAt,created_at AS createdAt,updated_at AS updatedAt FROM transaction_records WHERE id=? AND user_id=?`,
      [id, userId],
    )
    return rows[0] ?? null
  }
  async history(userId: string, limit: number, cursor?: string) {
    let date: Date | undefined, id: string | undefined
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as {
          date: string
          id: string
        }
        date = new Date(decoded.date)
        id = decoded.id
      } catch {
        throw new AppError('INVALID_CURSOR', 'History cursor is invalid', 400)
      }
    }
    const params: unknown[] = [userId]
    let after = ''
    if (date && id) {
      after = ` AND (r.created_at<? OR (r.created_at=? AND r.id<?))`
      params.push(date, date, id)
    }
    params.push(limit + 1)
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT r.id,r.intent_id AS intentId,r.quote_id AS quoteId,r.chain_family AS chainFamily,r.network_id AS networkId,r.tx_hash AS txHash,r.status,r.from_address AS fromAddress,r.to_address AS toAddress,r.summary,r.provider,r.failure_code AS failureCode,r.submitted_at AS submittedAt,r.confirmed_at AS confirmedAt,r.created_at AS createdAt,r.updated_at AS updatedAt FROM transaction_records r WHERE r.user_id=?${after} ORDER BY r.created_at DESC,r.id DESC LIMIT ?`,
      params as any,
    )
    const items = rows.slice(0, limit),
      last = items.at(-1)
    return {
      items,
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({ date: new Date(last.createdAt).toISOString(), id: last.id }),
            ).toString('base64url')
          : null,
    }
  }
  async reconciliationBatch(limit: number, maxAttempts: number) {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT r.id,r.intent_id AS intentId,r.chain_family AS chainFamily,r.network_id AS networkId,r.tx_hash AS txHash,r.status,r.reconcile_attempts AS attempts,r.created_at AS createdAt FROM transaction_records r WHERE r.status IN ('broadcasting','submitted','unknown') AND r.reconcile_attempts<? AND (r.next_reconcile_at IS NULL OR r.next_reconcile_at<=NOW(6)) ORDER BY r.next_reconcile_at,r.created_at LIMIT ?`,
      [maxAttempts, limit],
    )
    return rows
  }
  async changesSince(userId: string, since: Date) {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT id,intent_id AS intentId,network_id AS networkId,tx_hash AS txHash,status,summary,failure_code AS failureCode,updated_at AS updatedAt FROM transaction_records WHERE user_id=? AND updated_at>? ORDER BY updated_at,id LIMIT 100`,
      [userId, since],
    )
    return rows
  }
  async reconcile(
    id: string,
    status: 'submitted' | 'confirmed' | 'failed' | 'dropped' | 'unknown',
    attempts: number,
    max: number,
    detail?: string,
  ) {
    const terminal = ['confirmed', 'failed', 'dropped'].includes(status),
      finalStatus = !terminal && attempts >= max ? 'unknown' : status
    await this.pool.execute(
      `UPDATE transaction_records r JOIN transaction_intents i ON i.id=r.intent_id SET r.status=?,r.reconcile_attempts=?,r.next_reconcile_at=?,r.failure_code=?,r.failure_detail=?,r.confirmed_at=IF(?='confirmed',NOW(6),r.confirmed_at),r.finalized_at=IF(?,NOW(6),r.finalized_at),i.status=IF(? IN ('confirmed','failed'),?,i.status) WHERE r.id=?`,
      [
        finalStatus,
        attempts,
        terminal || attempts >= max
          ? null
          : new Date(Date.now() + Math.min(300, 15 * 2 ** Math.min(attempts, 4)) * 1000),
        detail ? finalStatus.toUpperCase() : null,
        detail?.slice(0, 500) ?? null,
        finalStatus,
        terminal,
        finalStatus,
        finalStatus,
        id,
      ],
    )
  }
  async control(name: string) {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT enabled,reason FROM operational_controls WHERE control_name=?`,
      [name],
    )
    return Boolean(rows[0]?.enabled)
  }
  async securityEvent(input: {
    userId?: string
    type: string
    outcome: string
    requestId?: string
    metadata?: unknown
  }) {
    await this.pool.execute(
      `INSERT INTO security_events(user_id,event_type,outcome,request_id,metadata) VALUES(?,?,?,?,?)`,
      [
        input.userId ?? null,
        input.type,
        input.outcome,
        input.requestId ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
      ],
    )
  }
}
