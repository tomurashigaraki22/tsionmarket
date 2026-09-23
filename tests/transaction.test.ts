import { describe, expect, it, vi } from 'vitest'
import type { Pool, PoolConnection } from 'mysql2/promise'
import { withTransaction } from '../src/db/transaction.js'
import { acquireConnection } from '../src/db/pool.js'

describe('transaction helper', () => {
  it('commits successful work and always releases the connection', async () => {
    const connection = {
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    } as unknown as PoolConnection
    const pool = { getConnection: vi.fn().mockResolvedValue(connection) } as unknown as Pool
    await expect(withTransaction(pool, async () => 'done')).resolves.toBe('done')
    expect(connection.commit).toHaveBeenCalledOnce()
    expect(connection.rollback).not.toHaveBeenCalled()
    expect(connection.release).toHaveBeenCalledOnce()
  })

  it('rolls back failed work and rethrows', async () => {
    const connection = {
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    } as unknown as PoolConnection
    const pool = { getConnection: vi.fn().mockResolvedValue(connection) } as unknown as Pool
    await expect(withTransaction(pool, async () => Promise.reject(new Error('failed')))).rejects.toThrow(
      'failed',
    )
    expect(connection.rollback).toHaveBeenCalledOnce()
    expect(connection.release).toHaveBeenCalledOnce()
  })

  it('bounds pool acquisition and releases a connection that arrives late', async () => {
    const release = vi.fn()
    let resolveConnection: ((connection: PoolConnection) => void) | undefined
    const pending = new Promise<PoolConnection>((resolve) => {
      resolveConnection = resolve
    })
    const pool = { getConnection: vi.fn().mockReturnValue(pending) } as unknown as Pool

    await expect(acquireConnection(pool, 5)).rejects.toThrow(/Timed out acquiring/)
    resolveConnection?.({ release } as unknown as PoolConnection)
    await pending
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(release).toHaveBeenCalledOnce()
  })
})
