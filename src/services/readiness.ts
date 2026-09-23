import type { Pool, RowDataPacket } from 'mysql2/promise'
import { assertMigrationsCurrent, discoverMigrations } from '../db/migrations.js'

export type ReadinessResult = {
  ready: boolean
  checks: {
    mysql: 'ready' | 'unavailable'
    migrations: 'current' | 'pending_or_invalid' | 'unknown'
  }
  reason?: string
}

export type ReadinessCheck = () => Promise<ReadinessResult>

export function createReadinessCheck(pool: Pool): ReadinessCheck {
  return async () => {
    try {
      await pool.query<RowDataPacket[]>({ sql: 'SELECT 1 AS healthy', timeout: 5_000 })
    } catch {
      return {
        ready: false,
        checks: { mysql: 'unavailable', migrations: 'unknown' },
        reason: 'Database unavailable',
      }
    }

    try {
      await assertMigrationsCurrent(pool, await discoverMigrations())
      return { ready: true, checks: { mysql: 'ready', migrations: 'current' } }
    } catch {
      return {
        ready: false,
        checks: { mysql: 'ready', migrations: 'pending_or_invalid' },
        reason: 'Database migrations are not current',
      }
    }
  }
}
