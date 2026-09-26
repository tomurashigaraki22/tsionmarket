import type { Pool, PoolConnection } from 'mysql2/promise'
import { describe, expect, it, vi } from 'vitest'
import { OnSwitchPaymentRepository } from '../src/payments/onswitch/repository.js'

describe('OnSwitch payment repository', () => {
  it('binds a value for every placeholder when creating a payment operation', async () => {
    const expiresAt = new Date(Date.now() + 60_000)
    let insert: { sql: string; values: unknown[] } | undefined
    const connection = {
      beginTransaction: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
      release: vi.fn(),
      execute: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.includes('SELECT id FROM users')) return [[{ id: 'user-a' }], []]
        if (sql.includes('request_fingerprint AS requestFingerprint')) return [[], []]
        if (sql.includes('COUNT(*) AS activeCount')) return [[{ activeCount: 0 }], []]
        if (sql.includes('FROM wallet_accounts')) return [[{ networkId: 'arbitrum-one' }], []]
        if (sql.includes('FROM payment_quotes'))
          return [[{ operationType: 'onramp', expiresAt, consumedAt: null }], []]
        if (sql.includes('INSERT INTO payment_operations')) {
          insert = { sql, values: values ?? [] }
          return [{ affectedRows: 1 }, []]
        }
        return [{ affectedRows: 1 }, []]
      }),
    } as unknown as PoolConnection
    const pool = {
      getConnection: vi.fn(async () => connection),
      execute: vi.fn(async () => [{ affectedRows: 1 }, []]),
    } as unknown as Pool
    const repository = new OnSwitchPaymentRepository(pool)

    const result = await repository.createOperation({
      userId: 'user-a',
      operationType: 'onramp',
      idempotencyKey: 'onramp-request-0001',
      requestFingerprint: 'f'.repeat(64),
      quoteId: 'quote-a',
      beneficiaryRefId: 'beneficiary-a',
      accountId: 'account-a',
      networkId: 'arbitrum-one',
      country: 'NG',
      fiatCurrency: 'NGN',
      channel: 'BANK',
      assetKey: 'arbitrum-one:usdc',
      sourceAmount: '1500',
      destinationAmount: '1',
      sourceAmountRaw: '1000000',
      destinationAmountRaw: '1000000',
      sourceDecimals: 6,
      destinationDecimals: 6,
      termsSnapshot: { quoteId: 'quote-a' },
      expiresAt,
    })

    expect(result.existing).toBe(false)
    expect(insert).toBeDefined()
    expect([...insert!.sql.matchAll(/\?/g)]).toHaveLength(insert!.values.length)
    expect(insert!.values).toHaveLength(21)
    expect(connection.commit).toHaveBeenCalledOnce()
    expect(connection.rollback).not.toHaveBeenCalled()
  })
})
