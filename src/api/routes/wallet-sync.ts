import { Router } from 'express'
import { z } from 'zod'
import { requireIdentity } from '../../auth/middleware.js'
import type { WalletSyncRepository } from '../../wallet/WalletSyncRepository.js'
import { asyncHandler } from '../../utils/asyncHandler.js'
import { AppError } from '../../utils/errors.js'
import { userRateLimit } from '../middleware/userRateLimit.js'

/** Every secret in a backup is one of these: an IV and AES-GCM ciphertext. */
const envelope = z
  .object({
    version: z.literal(1),
    iv: z.string().min(8).max(64),
    ciphertext: z.string().min(8).max(8192),
  })
  .strict()

/**
 * The shape of the portable backup the browser exports, and nothing else.
 *
 * `.strict()` is the safeguard, not decoration: a client that tried to send a
 * recovery phrase, a private key, or the device-bound PIN wrap would carry a
 * field outside this shape and be refused. The KDF floors stop a buggy or
 * hostile client from storing a backup that is cheap to brute-force offline.
 */
export const walletBackupSchema = z
  .object({
    format: z.literal('tsionmarket-wallet-backup'),
    formatVersion: z.literal(1),
    wallet: z
      .object({
        version: z.literal(1),
        walletId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
        createdAt: z.string().max(40),
        passphraseWrap: envelope
          .extend({
            kdf: z
              .object({
                name: z.literal('argon2id'),
                salt: z.string().min(16).max(64),
                memoryKiB: z.number().int().min(32_768).max(1_048_576),
                iterations: z.number().int().min(2).max(16),
                parallelism: z.number().int().min(1).max(8),
              })
              .strict(),
          })
          .strict(),
        accounts: z
          .array(
            z
              .object({
                family: z.enum(['evm', 'solana', 'intertrain']),
                address: z.string().min(1).max(128),
                publicKey: z.string().min(1).max(256),
                secret: envelope,
                derivationMetadata: z
                  .object({
                    source: z.literal('recovery-mnemonic'),
                    scheme: z.literal('slip10-ed25519'),
                    path: z.string().max(64),
                    version: z.literal(1),
                  })
                  .strict()
                  .optional(),
              })
              .strict(),
          )
          .min(1)
          .max(16),
        mnemonic: envelope,
      })
      .strict(),
  })
  .strict()

export const walletSyncPutSchema = z
  .object({
    backup: walletBackupSchema,
    expectedVersion: z.number().int().min(0),
    replace: z.boolean().default(false),
  })
  .strict()

export function walletSyncRouter(repository: WalletSyncRepository) {
  const router = Router()
  const limit = userRateLimit({ windowMs: 10 * 60_000, limit: 30 })
  router.use('/wallet/sync', limit)

  router.get(
    '/wallet/sync',
    asyncHandler(async (req, res) => {
      const record = await repository.get(requireIdentity(req).userId)
      res.set('Cache-Control', 'no-store')
      res.json({ success: true, data: record ? { exists: true, ...record } : { exists: false } })
    }),
  )

  router.put(
    '/wallet/sync',
    asyncHandler(async (req, res) => {
      const parsed = walletSyncPutSchema.safeParse(req.body)
      if (!parsed.success)
        throw new AppError('WALLET_SYNC_INVALID', 'Only an encrypted wallet backup can be stored.', 400)
      const { backup, expectedVersion, replace } = parsed.data
      const saved = await repository.put(
        requireIdentity(req).userId,
        { walletId: backup.wallet.walletId, backup, expectedVersion, replace },
        req.requestId,
      )
      res.set('Cache-Control', 'no-store')
      res.json({
        success: true,
        data: { walletId: saved.walletId, version: saved.version, updatedAt: saved.updatedAt },
      })
    }),
  )

  router.delete(
    '/wallet/sync',
    asyncHandler(async (req, res) => {
      const removed = await repository.delete(requireIdentity(req).userId, req.requestId)
      res.json({ success: true, data: { removed } })
    }),
  )
  return router
}
