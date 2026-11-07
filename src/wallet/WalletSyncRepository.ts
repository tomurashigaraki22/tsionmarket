import type { Pool, RowDataPacket } from 'mysql2/promise'
import { withTransaction } from '../db/transaction.js'
import { AppError } from '../utils/errors.js'

export type WalletSyncRecord = {
  walletId: string
  version: number
  updatedAt: string
  backup: unknown
}

/**
 * Holds one encrypted wallet backup per user. The content is opaque here: it
 * is validated for shape at the route and never decrypted, indexed, or logged.
 */
export class WalletSyncRepository {
  constructor(private readonly pool: Pool) {}

  async get(userId: string): Promise<WalletSyncRecord | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT wallet_id AS walletId, version, updated_at AS updatedAt, backup
       FROM wallet_sync_backups WHERE user_id=?`,
      [userId],
    )
    const row = rows[0]
    return row ? toRecord(row) : null
  }

  /**
   * Writes the backup if the caller has seen the current one.
   *
   * `expectedVersion` is 0 for a first upload. A stale version means another
   * device wrote in between, and overwriting would silently discard its wallet
   * changes, so it is refused. Replacing a backup that belongs to a different
   * wallet is refused unless the caller says so explicitly: that is how a
   * second, unrelated wallet would orphan the first.
   */
  async put(
    userId: string,
    input: { walletId: string; backup: unknown; expectedVersion: number; replace: boolean },
    requestId?: string,
  ): Promise<WalletSyncRecord> {
    const serialized = JSON.stringify(input.backup)
    return withTransaction(this.pool, async (connection) => {
      const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT wallet_id AS walletId, version FROM wallet_sync_backups WHERE user_id=? FOR UPDATE`,
        [userId],
      )
      const current = rows[0]
      if (current) {
        if (Number(current.version) !== input.expectedVersion)
          throw new AppError('WALLET_SYNC_CONFLICT', 'A newer wallet backup exists. Pull it first.', 409, {
            currentVersion: Number(current.version),
          })
        if (current.walletId !== input.walletId && !input.replace)
          throw new AppError(
            'WALLET_SYNC_DIFFERENT_WALLET',
            'A different wallet is already backed up for this account.',
            409,
            { currentWalletId: String(current.walletId) },
          )
        await connection.execute(
          `UPDATE wallet_sync_backups SET wallet_id=?, backup=?, version=version+1 WHERE user_id=?`,
          [input.walletId, serialized, userId],
        )
      } else {
        if (input.expectedVersion !== 0)
          throw new AppError('WALLET_SYNC_CONFLICT', 'No wallet backup exists at that version.', 409, {
            currentVersion: 0,
          })
        await connection.execute(
          `INSERT INTO wallet_sync_backups(user_id, wallet_id, backup) VALUES(?,?,?)`,
          [userId, input.walletId, serialized],
        )
      }
      await this.audit(connection, userId, current ? 'wallet_sync_update' : 'wallet_sync_create', requestId)
      const [saved] = await connection.execute<RowDataPacket[]>(
        `SELECT wallet_id AS walletId, version, updated_at AS updatedAt, backup
         FROM wallet_sync_backups WHERE user_id=?`,
        [userId],
      )
      return toRecord(saved[0]!)
    })
  }

  async delete(userId: string, requestId?: string): Promise<boolean> {
    return withTransaction(this.pool, async (connection) => {
      const [result] = await connection.execute(`DELETE FROM wallet_sync_backups WHERE user_id=?`, [userId])
      const removed = Boolean((result as { affectedRows?: number }).affectedRows)
      if (removed) await this.audit(connection, userId, 'wallet_sync_delete', requestId)
      return removed
    })
  }

  private async audit(
    connection: { execute: Pool['execute'] },
    userId: string,
    type: string,
    requestId?: string,
  ) {
    await connection.execute(
      `INSERT INTO security_events(user_id,event_type,outcome,request_id,metadata) VALUES(?,?,?,?,?)`,
      [userId, type, 'success', requestId ?? null, null],
    )
  }
}

function toRecord(row: RowDataPacket): WalletSyncRecord {
  return {
    walletId: String(row.walletId),
    version: Number(row.version),
    updatedAt: new Date(row.updatedAt as Date | string).toISOString(),
    backup: JSON.parse(String(row.backup)) as unknown,
  }
}
