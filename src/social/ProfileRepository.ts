import { randomUUID } from 'node:crypto'
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import { withTransaction } from '../db/transaction.js'
import { AppError } from '../utils/errors.js'

export type UserRole = 'user' | 'verified' | 'admin'

export type Profile = {
  userId: string
  handle: string
  displayName: string
  bio: string | null
  avatarSeed: string
  intertrainAccountId: string | null
  intertrainAddress: string | null
  role: UserRole
  createdAt: string
}

/**
 * A profile as it is safe to hand to another user.
 *
 * `userId` is kept because posts reference it, but the email that identifies
 * the account never leaves the auth tables. Nothing in this file selects it.
 */
const PROFILE_COLUMNS = `p.user_id AS userId, p.handle, p.display_name AS displayName,
  p.bio, p.avatar_seed AS avatarSeed, p.intertrain_account_id AS intertrainAccountId,
  wa.address AS intertrainAddress, u.role, p.created_at AS createdAt`

export class ProfileRepository {
  constructor(private readonly pool: Pool) {}

  async byUserId(userId: string): Promise<Profile | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT ${PROFILE_COLUMNS} FROM user_profiles p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN wallet_accounts wa ON wa.id=p.intertrain_account_id AND wa.user_id=p.user_id AND wa.network_id='intertrain-mainnet' AND wa.status='active' AND wa.ownership_status='verified'
       WHERE p.user_id = ?`,
      [userId],
    )
    return (rows[0] as Profile | undefined) ?? null
  }

  async byHandle(handle: string): Promise<Profile | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT ${PROFILE_COLUMNS} FROM user_profiles p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN wallet_accounts wa ON wa.id=p.intertrain_account_id AND wa.user_id=p.user_id AND wa.network_id='intertrain-mainnet' AND wa.status='active' AND wa.ownership_status='verified'
       WHERE p.handle = ?`,
      [handle],
    )
    return (rows[0] as Profile | undefined) ?? null
  }

  /**
   * Claims a handle for a user.
   *
   * The reservation check and the insert share a transaction: two accounts
   * submitting the same handle at once must not both pass the availability
   * check before either writes. The UNIQUE index is the final backstop, and a
   * duplicate-key error is translated rather than surfaced as a 500.
   */
  async create(input: {
    userId: string
    handle: string
    displayName: string
    intertrainAccountId?: string | undefined
  }): Promise<Profile> {
    await withTransaction(this.pool, async (connection) => {
      const [existing] = await connection.execute<RowDataPacket[]>(
        'SELECT user_id FROM user_profiles WHERE user_id = ?',
        [input.userId],
      )
      if (existing[0]) throw new AppError('PROFILE_EXISTS', 'This account already has a profile', 409)

      const [reserved] = await connection.execute<RowDataPacket[]>(
        'SELECT handle, reserved_for_user_id AS reservedFor FROM reserved_handles WHERE handle = ? FOR UPDATE',
        [input.handle],
      )
      const reservation = reserved[0] as { reservedFor: string | null } | undefined
      // A reservation held for this very account is a reservation, not a block.
      if (reservation && reservation.reservedFor !== input.userId)
        throw new AppError('HANDLE_RESERVED', 'That handle is not available', 409)

      if (input.intertrainAccountId)
        await this.assertOwnedIntertrainAccount(connection, input.userId, input.intertrainAccountId)

      try {
        await connection.execute(
          `INSERT INTO user_profiles (user_id, handle, display_name, avatar_seed, intertrain_account_id)
           VALUES (?, ?, ?, ?, ?)`,
          [input.userId, input.handle, input.displayName, randomUUID(), input.intertrainAccountId ?? null],
        )
      } catch (error) {
        if ((error as { code?: string }).code === 'ER_DUP_ENTRY')
          throw new AppError('HANDLE_TAKEN', 'That handle is already taken', 409)
        throw error
      }

      // The reservation has been redeemed; leaving it would block the owner
      // from ever changing their display name through a future flow.
      if (reservation)
        await connection.execute('DELETE FROM reserved_handles WHERE handle = ?', [input.handle])
    })

    const profile = await this.byUserId(input.userId)
    if (!profile) throw new AppError('PROFILE_CREATE_FAILED', 'Profile could not be created', 500)
    return profile
  }

  async linkIntertrainAccount(userId: string, accountId: string | null): Promise<Profile> {
    if (accountId) {
      await withTransaction(this.pool, async (connection) => {
        await this.assertOwnedIntertrainAccount(connection, userId, accountId)
        try {
          const [result] = await connection.execute(
            'UPDATE user_profiles SET intertrain_account_id=? WHERE user_id=?',
            [accountId, userId],
          )
          if ((result as { affectedRows?: number }).affectedRows !== 1)
            throw new AppError('PROFILE_NOT_FOUND', 'Claim a free TsionMarket ID first', 404)
        } catch (error) {
          if ((error as { code?: string }).code === 'ER_DUP_ENTRY')
            throw new AppError(
              'INTERTRAIN_ACCOUNT_ALREADY_LINKED',
              'That Intertrain account is already linked to another ID',
              409,
            )
          throw error
        }
      })
    } else {
      const [result] = await this.pool.execute(
        'UPDATE user_profiles SET intertrain_account_id=NULL WHERE user_id=?',
        [userId],
      )
      if ((result as { affectedRows?: number }).affectedRows !== 1)
        throw new AppError('PROFILE_NOT_FOUND', 'No TsionMarket ID is linked to this account', 404)
    }
    const profile = await this.byUserId(userId)
    if (!profile) throw new AppError('PROFILE_NOT_FOUND', 'No profile exists for this account', 404)
    return profile
  }

  private async assertOwnedIntertrainAccount(connection: PoolConnection, userId: string, accountId: string) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT id FROM wallet_accounts
       WHERE id=? AND user_id=? AND network_id='intertrain-mainnet'
         AND status='active' AND ownership_status='verified' FOR UPDATE`,
      [accountId, userId],
    )
    if (!rows[0])
      throw new AppError(
        'INTERTRAIN_ACCOUNT_NOT_VERIFIED',
        'Choose an Intertrain wallet verified in your TsionMarket Wallet page',
        409,
      )
  }

  /**
   * Handle is deliberately absent: a mutable handle lets an account build
   * reputation under one name and hand it to an impersonator under another.
   */
  async update(
    userId: string,
    input: { displayName?: string | undefined; bio?: string | null | undefined },
  ): Promise<Profile> {
    const sets: string[] = []
    const params: Array<string | null> = []
    if (input.displayName !== undefined) {
      sets.push('display_name = ?')
      params.push(input.displayName)
    }
    if (input.bio !== undefined) {
      sets.push('bio = ?')
      params.push(input.bio)
    }
    if (sets.length > 0) {
      params.push(userId)
      await this.pool.execute(`UPDATE user_profiles SET ${sets.join(', ')} WHERE user_id = ?`, params)
    }
    const profile = await this.byUserId(userId)
    if (!profile) throw new AppError('PROFILE_NOT_FOUND', 'No profile exists for this account', 404)
    return profile
  }

  /** Whether a handle can be claimed, for the composer's live availability check. */
  async isAvailable(handle: string, forUserId: string): Promise<boolean> {
    const [taken] = await this.pool.execute<RowDataPacket[]>('SELECT 1 FROM user_profiles WHERE handle = ?', [
      handle,
    ])
    if (taken[0]) return false
    const [reserved] = await this.pool.execute<RowDataPacket[]>(
      'SELECT reserved_for_user_id AS reservedFor FROM reserved_handles WHERE handle = ?',
      [handle],
    )
    const reservation = reserved[0] as { reservedFor: string | null } | undefined
    return !reservation || reservation.reservedFor === forUserId
  }
}
