import type { Pool, PoolConnection } from 'mysql2/promise'
import { acquireConnection } from './pool.js'

export async function withTransaction<T>(
  pool: Pool,
  work: (connection: PoolConnection) => Promise<T>,
  acquisitionTimeoutMs = 10_000,
): Promise<T> {
  const connection = await acquireConnection(pool, acquisitionTimeoutMs)
  try {
    await connection.beginTransaction()
    const result = await work(connection)
    await connection.commit()
    return result
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}
