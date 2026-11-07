import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { walletBackupSchema, walletSyncRouter } from '../src/api/routes/wallet-sync.js'
import { errorHandler } from '../src/api/middleware/errorHandler.js'
import { AppError } from '../src/utils/errors.js'
import type { WalletSyncRecord, WalletSyncRepository } from '../src/wallet/WalletSyncRepository.js'

const envelope = { version: 1, iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'Y2lwaGVydGV4dC1ieXRlcw==' }
const backup = (overrides: Record<string, unknown> = {}) => ({
  format: 'tsionmarket-wallet-backup',
  formatVersion: 1,
  wallet: {
    version: 1,
    walletId: 'wallet_0123456789',
    createdAt: '2026-11-07T00:00:00.000Z',
    passphraseWrap: {
      ...envelope,
      kdf: {
        name: 'argon2id',
        salt: 'c2FsdHNhbHRzYWx0c2FsdA==',
        memoryKiB: 65536,
        iterations: 3,
        parallelism: 1,
      },
    },
    accounts: [
      {
        family: 'evm',
        address: '0x0000000000000000000000000000000000000001',
        publicKey: '0x04aa',
        secret: envelope,
      },
    ],
    mnemonic: envelope,
    ...overrides,
  },
})

describe('wallet backup shape', () => {
  it('accepts the encrypted backup the browser exports', () => {
    expect(walletBackupSchema.safeParse(backup()).success).toBe(true)
  })

  it('refuses anything that is not an encrypted envelope', () => {
    // A recovery phrase, a raw key, or the device-bound PIN wrap must never
    // reach the server, even by mistake.
    for (const extra of [
      { recoveryPhrase: 'abandon abandon abandon' },
      { privateKey: '0xdeadbeef' },
      { pinWrap: envelope },
    ])
      expect(walletBackupSchema.safeParse(backup(extra)).success).toBe(false)

    const plaintext = backup({
      accounts: [{ family: 'evm', address: '0x1', publicKey: '0x2', secret: 'a plain private key' }],
    })
    expect(walletBackupSchema.safeParse(plaintext).success).toBe(false)
  })

  it('refuses a key-derivation setting that is cheap to brute-force offline', () => {
    const weak = backup({
      passphraseWrap: {
        ...envelope,
        kdf: {
          name: 'argon2id',
          salt: 'c2FsdHNhbHRzYWx0c2FsdA==',
          memoryKiB: 1024,
          iterations: 1,
          parallelism: 1,
        },
      },
    })
    expect(walletBackupSchema.safeParse(weak).success).toBe(false)
  })
})

function app(repository: Partial<WalletSyncRepository>) {
  const server = express()
  server.use(express.json({ limit: '256kb' }))
  server.use((req, _res, next) => {
    req.identity = { userId: 'user-1' } as Express.Request['identity']
    next()
  })
  server.use('/v1', walletSyncRouter(repository as WalletSyncRepository))
  server.use(errorHandler)
  return server
}

describe('wallet sync routes', () => {
  it('says there is no backup rather than failing', async () => {
    const response = await request(app({ get: async () => null })).get('/v1/wallet/sync')
    expect(response.status).toBe(200)
    expect(response.body.data).toEqual({ exists: false })
    expect(response.headers['cache-control']).toBe('no-store')
  })

  it('stores a valid backup against the signed-in user only', async () => {
    let seen: { userId: string; walletId: string; expected: number } | undefined
    const repository = {
      put: async (userId: string, input: { walletId: string; expectedVersion: number }) => {
        seen = { userId, walletId: input.walletId, expected: input.expectedVersion }
        return {
          walletId: input.walletId,
          version: 1,
          updatedAt: '2026-11-07T00:00:00.000Z',
        } as WalletSyncRecord
      },
    }
    const response = await request(app(repository))
      .put('/v1/wallet/sync')
      .send({ backup: backup(), expectedVersion: 0 })
    expect(response.status).toBe(200)
    expect(response.body.data).toMatchObject({ walletId: 'wallet_0123456789', version: 1 })
    expect(seen).toEqual({ userId: 'user-1', walletId: 'wallet_0123456789', expected: 0 })
  })

  it('rejects an upload that carries plaintext and never reaches storage', async () => {
    let called = false
    const response = await request(
      app({
        put: async () => {
          called = true
          return {} as WalletSyncRecord
        },
      }),
    )
      .put('/v1/wallet/sync')
      .send({ backup: backup({ recoveryPhrase: 'abandon abandon' }), expectedVersion: 0 })
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('WALLET_SYNC_INVALID')
    expect(called).toBe(false)
  })

  it('reports a conflict when another device wrote first', async () => {
    const response = await request(
      app({
        put: async () => {
          throw new AppError('WALLET_SYNC_CONFLICT', 'A newer wallet backup exists. Pull it first.', 409)
        },
      }),
    )
      .put('/v1/wallet/sync')
      .send({ backup: backup(), expectedVersion: 3 })
    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('WALLET_SYNC_CONFLICT')
  })
})
