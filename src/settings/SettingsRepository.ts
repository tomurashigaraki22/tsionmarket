import type { Pool, RowDataPacket } from 'mysql2/promise'

export type UserSettings = {
  displayName: string
  transactionUpdatesEnabled: boolean
  productUpdatesEnabled: boolean
  updatedAt: string | null
}

const DEFAULT_SETTINGS: UserSettings = {
  displayName: '',
  transactionUpdatesEnabled: true,
  productUpdatesEnabled: false,
  updatedAt: null,
}

export class SettingsRepository {
  constructor(private readonly pool: Pool) {}

  async get(userId: string): Promise<UserSettings> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT display_name AS displayName,
        transaction_updates_enabled AS transactionUpdatesEnabled,
        product_updates_enabled AS productUpdatesEnabled,
        updated_at AS updatedAt
       FROM user_settings WHERE user_id=?`,
      [userId],
    )
    const row = rows[0]
    if (!row) return DEFAULT_SETTINGS
    return {
      displayName: String(row.displayName ?? ''),
      transactionUpdatesEnabled: Boolean(row.transactionUpdatesEnabled),
      productUpdatesEnabled: Boolean(row.productUpdatesEnabled),
      updatedAt: row.updatedAt ? new Date(row.updatedAt as Date | string).toISOString() : null,
    }
  }

  async update(
    userId: string,
    input: Partial<Pick<UserSettings, 'displayName' | 'transactionUpdatesEnabled' | 'productUpdatesEnabled'>>,
  ): Promise<UserSettings> {
    const current = await this.get(userId)
    const next = { ...current, ...input }
    await this.pool.execute(
      `INSERT INTO user_settings(user_id,display_name,transaction_updates_enabled,product_updates_enabled)
       VALUES(?,?,?,?)
       ON DUPLICATE KEY UPDATE display_name=VALUES(display_name),
         transaction_updates_enabled=VALUES(transaction_updates_enabled),
         product_updates_enabled=VALUES(product_updates_enabled)`,
      [userId, next.displayName, next.transactionUpdatesEnabled, next.productUpdatesEnabled],
    )
    return this.get(userId)
  }
}
