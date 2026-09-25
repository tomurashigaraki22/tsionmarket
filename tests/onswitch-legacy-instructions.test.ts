import type { Pool } from 'mysql2/promise'
import { describe, expect, it, vi } from 'vitest'
import { OnSwitchPaymentRepository } from '../src/payments/onswitch/repository.js'
import { decryptPaymentInstructions } from '../src/payments/onswitch/secureData.js'

const key = 'f'.repeat(64)

function operationRow(status: string, safeInstructions: unknown) {
  const now = new Date()
  return {
    id: 'b163b3bc-9f48-4717-87cf-730a3ee98f84',
    userId: '86ee05f9-a795-4d71-9c75-a9b638f6e13c',
    operationType: 'onramp',
    status,
    providerReference: 'b163b3bc-9f48-4717-87cf-730a3ee98f84',
    requestFingerprint: 'f'.repeat(64),
    providerStatus: 'AWAITING_PAYMENT',
    reconcileAttempts: 0,
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
    termsSnapshot: JSON.stringify({}),
    safeInstructions: JSON.stringify(safeInstructions),
    country: 'NG',
    fiatCurrency: 'NGN',
    channel: 'BANK',
    assetKey: 'arbitrum-one:usdc',
    sourceAmount: '1000',
    destinationAmount: '1',
    chainTxHash: null,
    accountId: null,
    networkId: 'arbitrum-one',
  }
}

describe('legacy OnSwitch instruction migration', () => {
  it('encrypts a pending legacy instruction on first read', async () => {
    const instructions = { deposit: { accountNumber: '0123456789' } }
    const row = operationRow('awaiting_fiat', instructions)
    const execute = vi.fn(async (...args: unknown[]) => {
      const sql = String(args[0])
      if (sql.startsWith('SELECT p.id')) return [[row], []]
      return [{ affectedRows: 1 }, []]
    })
    const repository = new OnSwitchPaymentRepository({ execute } as unknown as Pool, key)

    const payment = await repository.getForUser(row.userId, row.id)

    expect(payment?.instructions).toEqual(instructions)
    const update = execute.mock.calls.find(([sql]) => String(sql).startsWith('UPDATE payment_operations'))
    expect(update).toBeDefined()
    const parameters = update?.[1] as unknown[] | undefined
    expect(String(parameters?.[0])).not.toContain('0123456789')
    const encrypted = JSON.parse(String(parameters?.[0])) as unknown
    expect(decryptPaymentInstructions(encrypted, key)).toEqual(instructions)
  })

  it('clears legacy instructions for terminal operations instead of retaining them', async () => {
    const row = operationRow('completed', { deposit: { accountNumber: '0123456789' } })
    const execute = vi.fn(async (...args: unknown[]) => {
      const sql = String(args[0])
      if (sql.startsWith('SELECT p.id')) return [[row], []]
      return [{ affectedRows: 1 }, []]
    })
    const repository = new OnSwitchPaymentRepository({ execute } as unknown as Pool, key)

    const payment = await repository.getForUser(row.userId, row.id)

    expect(payment?.instructions).toBeNull()
    const update = execute.mock.calls.find(([sql]) => String(sql).startsWith('UPDATE payment_operations'))
    expect(update?.[0]).toContain('SET safe_instructions=NULL')
  })
})
