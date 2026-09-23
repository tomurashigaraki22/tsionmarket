import { randomUUID } from 'node:crypto'
import type { Pool, RowDataPacket } from 'mysql2/promise'
import { withTransaction } from '../db/transaction.js'
import { AppError } from '../utils/errors.js'

export type OwnershipChallenge = {
  id: string
  userId: string
  networkId: string
  address: string
  nonce: string
  statement: string
  signatureScheme: 'eip191-v1' | 'ed25519-v1'
  issuedAt: string
  expiresAt: string
  consumedAt: string | null
  failedAttempts: number
}

export class OwnershipRepository {
  constructor(private readonly pool: Pool) {}

  async createChallenge(challenge: OwnershipChallenge): Promise<void> {
    await this.pool.execute(
      `INSERT INTO wallet_ownership_challenges
       (id,user_id,network_id,address,nonce,statement,signature_scheme,issued_at,expires_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      [
        challenge.id,
        challenge.userId,
        challenge.networkId,
        challenge.address,
        challenge.nonce,
        challenge.statement,
        challenge.signatureScheme,
        challenge.issuedAt,
        challenge.expiresAt,
      ],
    )
  }

  async register(input: {
    userId: string
    challengeId: string
    networkId: string
    address: string
    label?: string | undefined
    idempotencyKey: string
    requestHash: string
    verify: (challenge: OwnershipChallenge) => Promise<boolean>
  }): Promise<{ id: string; existing: boolean }> {
    const result = await withTransaction<
      { id: string; existing: boolean; invalid?: false } | { invalid: true }
    >(this.pool, async (connection) => {
      const [replays] = await connection.execute<RowDataPacket[]>(
        `SELECT request_hash AS requestHash,account_id AS accountId FROM wallet_registration_idempotency
         WHERE user_id=? AND idempotency_key=? FOR UPDATE`,
        [input.userId, input.idempotencyKey],
      )
      if (replays[0]) {
        if (replays[0].requestHash !== input.requestHash)
          throw new AppError('IDEMPOTENCY_CONFLICT', 'Idempotency key was used for another request', 409)
        return { id: String(replays[0].accountId), existing: true }
      }

      const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT id,user_id AS userId,network_id AS networkId,address,nonce,statement,
          signature_scheme AS signatureScheme,issued_at AS issuedAt,expires_at AS expiresAt,
          consumed_at AS consumedAt,failed_attempts AS failedAttempts
         FROM wallet_ownership_challenges WHERE id=? AND user_id=? FOR UPDATE`,
        [input.challengeId, input.userId],
      )
      const challenge = rows[0] as OwnershipChallenge | undefined
      if (!challenge || challenge.consumedAt)
        throw new AppError('OWNERSHIP_CHALLENGE_INVALID', 'Ownership challenge is invalid', 400)
      if (new Date(challenge.expiresAt).getTime() <= Date.now())
        throw new AppError('OWNERSHIP_CHALLENGE_EXPIRED', 'Ownership challenge has expired', 400)
      if (challenge.networkId !== input.networkId || challenge.address !== input.address)
        throw new AppError('OWNERSHIP_PROOF_MISMATCH', 'Proof does not match the challenge', 400)
      if (challenge.failedAttempts >= 5)
        throw new AppError('OWNERSHIP_PROOF_LOCKED', 'Too many failed ownership proofs', 429)
      if (!(await input.verify(challenge))) {
        await connection.execute(
          'UPDATE wallet_ownership_challenges SET failed_attempts=failed_attempts+1 WHERE id=?',
          [challenge.id],
        )
        await connection.execute(
          `INSERT INTO security_events(user_id,event_type,outcome,metadata)
           VALUES(?,'wallet_ownership_proof','failure',?)`,
          [input.userId, JSON.stringify({ networkId: input.networkId, challengeId: input.challengeId })],
        )
        return { invalid: true }
      }

      const [owners] = await connection.execute<RowDataPacket[]>(
        'SELECT user_id AS userId,account_id AS accountId FROM wallet_account_ownership WHERE network_id=? AND address=? FOR UPDATE',
        [input.networkId, input.address],
      )
      if (owners[0] && owners[0].userId !== input.userId)
        throw new AppError('ADDRESS_ALREADY_OWNED', 'This address is already associated with an account', 409)

      let accountId = owners[0]?.accountId ? String(owners[0].accountId) : randomUUID()
      if (!owners[0]) {
        await connection.execute(
          `INSERT INTO wallet_accounts(id,user_id,network_id,address,label,status,ownership_status,verified_at)
           VALUES(?,?,?,?,?,'active','verified',CURRENT_TIMESTAMP(6))
           ON DUPLICATE KEY UPDATE label=VALUES(label),status='active',ownership_status='verified',verified_at=CURRENT_TIMESTAMP(6),id=LAST_INSERT_ID(id)`,
          [accountId, input.userId, input.networkId, input.address, input.label ?? null],
        )
        const [accounts] = await connection.execute<RowDataPacket[]>(
          'SELECT id FROM wallet_accounts WHERE user_id=? AND network_id=? AND address=?',
          [input.userId, input.networkId, input.address],
        )
        accountId = String(accounts[0]?.id ?? accountId)
        await connection.execute(
          'INSERT INTO wallet_account_ownership(network_id,address,user_id,account_id,challenge_id) VALUES(?,?,?,?,?)',
          [input.networkId, input.address, input.userId, accountId, challenge.id],
        )
      }
      await connection.execute(
        'UPDATE wallet_ownership_challenges SET consumed_at=CURRENT_TIMESTAMP(6) WHERE id=?',
        [challenge.id],
      )
      await connection.execute(
        'INSERT INTO wallet_registration_idempotency(user_id,idempotency_key,request_hash,account_id) VALUES(?,?,?,?)',
        [input.userId, input.idempotencyKey, input.requestHash, accountId],
      )
      await connection.execute(
        `INSERT INTO security_events(user_id,event_type,outcome,metadata)
         VALUES(?,'wallet_ownership_proof','success',?)`,
        [input.userId, JSON.stringify({ networkId: input.networkId, accountId })],
      )
      return { id: accountId, existing: Boolean(owners[0]) }
    })
    if (result.invalid)
      throw new AppError('OWNERSHIP_PROOF_INVALID', 'Wallet ownership proof is invalid', 400)
    return result
  }
}
