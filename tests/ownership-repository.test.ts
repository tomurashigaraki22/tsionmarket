import { describe, expect, it, vi } from 'vitest'
import type { Pool, PoolConnection } from 'mysql2/promise'
import { OwnershipRepository, type OwnershipChallenge } from '../src/portfolio/OwnershipRepository.js'
import { AppError } from '../src/utils/errors.js'

const challenge: OwnershipChallenge = {
  id: 'challenge-id',
  userId: 'user-a',
  networkId: 'ethereum-mainnet',
  address: '0xabc',
  nonce: 'nonce',
  statement: 'statement',
  signatureScheme: 'eip191-v1',
  issuedAt: new Date(Date.now() - 1000).toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  consumedAt: null,
  failedAttempts: 0,
}

function repositoryWith(responder: (sql: string) => unknown[]) {
  const connection = {
    beginTransaction: vi.fn(),
    commit: vi.fn(),
    rollback: vi.fn(),
    release: vi.fn(),
    execute: vi.fn((sql: string) => Promise.resolve([responder(sql)])),
  } as unknown as PoolConnection
  const pool = { getConnection: vi.fn().mockResolvedValue(connection) } as unknown as Pool
  return { repository: new OwnershipRepository(pool), connection }
}

function register(repository: OwnershipRepository, verify = true) {
  return repository.register({
    userId: 'user-a',
    challengeId: 'challenge-id',
    networkId: 'ethereum-mainnet',
    address: '0xabc',
    idempotencyKey: 'idempotent-key',
    requestHash: 'request-hash',
    verify: async () => verify,
  })
}

describe('ownership repository invariants', () => {
  it('returns the same account for an exact idempotent retry', async () => {
    const { repository } = repositoryWith((sql) =>
      sql.includes('wallet_registration_idempotency')
        ? [{ requestHash: 'request-hash', accountId: 'existing-account' }]
        : [],
    )
    await expect(register(repository)).resolves.toEqual({ id: 'existing-account', existing: true })
  })

  it('rejects replayed, expired, cross-user, and wrong-network challenges', async () => {
    for (const row of [
      { ...challenge, consumedAt: new Date().toISOString() },
      { ...challenge, expiresAt: new Date(Date.now() - 1).toISOString() },
      undefined,
      { ...challenge, networkId: 'arbitrum-one' },
    ]) {
      const { repository } = repositoryWith((sql) =>
        sql.includes('wallet_ownership_challenges') && row ? [row] : [],
      )
      await expect(register(repository)).rejects.toBeInstanceOf(AppError)
    }
  })

  it('persists malformed-signature attempts before rejecting', async () => {
    const { repository, connection } = repositoryWith((sql) =>
      sql.includes('wallet_ownership_challenges') && sql.trimStart().startsWith('SELECT') ? [challenge] : [],
    )
    await expect(register(repository, false)).rejects.toMatchObject({ code: 'OWNERSHIP_PROOF_INVALID' })
    expect(connection.commit).toHaveBeenCalledOnce()
    expect(connection.execute).toHaveBeenCalledWith(
      expect.stringContaining('failed_attempts=failed_attempts+1'),
      ['challenge-id'],
    )
  })

  it('prevents an address verified by another user from being reassigned', async () => {
    const { repository } = repositoryWith((sql) => {
      if (sql.includes('wallet_ownership_challenges') && sql.trimStart().startsWith('SELECT'))
        return [challenge]
      if (sql.includes('wallet_account_ownership') && sql.trimStart().startsWith('SELECT'))
        return [{ userId: 'user-b', accountId: 'their-account' }]
      return []
    })
    await expect(register(repository)).rejects.toMatchObject({ code: 'ADDRESS_ALREADY_OWNED' })
  })
})
