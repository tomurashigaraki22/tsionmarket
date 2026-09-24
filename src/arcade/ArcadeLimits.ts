import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import { AppError } from '../utils/errors.js'
import { compare } from './StakeRepository.js'

/**
 * An unverified address is not an identity, and a minutes-old account is the
 * shape multi-accounting arrives in. The composite key on arcade_entries stops
 * one ACCOUNT entering twice; this raises the cost of having a second account
 * at all. Same gate the Floor uses, for the same reason.
 */
const MIN_ACCOUNT_AGE_MINUTES = 30

export type PlayerLimits = {
  dailyEntryLimit: number | null
  dailyLossLimit: string | null
  selfExcludedUntil: string | null
}

export class ArcadeLimits {
  constructor(private readonly pool: Pool) {}

  async forUser(userId: string): Promise<PlayerLimits> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT daily_entry_limit AS dailyEntryLimit,
        CAST(daily_loss_limit AS CHAR) AS dailyLossLimit,
        self_excluded_until AS selfExcludedUntil
       FROM arcade_limits WHERE user_id = ?`,
      [userId],
    )
    const row = rows[0]
    return {
      dailyEntryLimit: (row?.dailyEntryLimit as number | null) ?? null,
      dailyLossLimit: (row?.dailyLossLimit as string | null) ?? null,
      selfExcludedUntil: (row?.selfExcludedUntil as string | null) ?? null,
    }
  }

  /**
   * Saves limits.
   *
   * Tightening applies at once; loosening is the part that needs care. A
   * self-exclusion can only ever be extended — the whole point is that the
   * person who set it cannot undo it in the moment they most want to. Loss and
   * entry limits can be raised, but that is the place to add a cooling-off
   * delay when the licence requires one.
   */
  async save(userId: string, input: PlayerLimits): Promise<PlayerLimits> {
    const current = await this.forUser(userId)
    const excluded = laterOf(current.selfExcludedUntil, input.selfExcludedUntil)

    await this.pool.execute(
      `INSERT INTO arcade_limits
        (user_id, daily_entry_limit, daily_loss_limit, self_excluded_until)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         daily_entry_limit = VALUES(daily_entry_limit),
         daily_loss_limit = VALUES(daily_loss_limit),
         self_excluded_until = VALUES(self_excluded_until)`,
      [userId, input.dailyEntryLimit, input.dailyLossLimit, excluded],
    )
    return this.forUser(userId)
  }

  /**
   * Everything that must be true before a player takes a seat, checked inside
   * the join transaction so a limit cannot be raced by two joins at once.
   */
  async assertMayJoin(
    connection: PoolConnection,
    userId: string,
    stake: { asset: string; amount: string } | null,
  ): Promise<void> {
    const [accounts] = await connection.execute<RowDataPacket[]>(
      `SELECT email_verified_at AS emailVerifiedAt,
        TIMESTAMPDIFF(MINUTE, created_at, NOW(6)) AS ageMinutes
       FROM users WHERE id = ?`,
      [userId],
    )
    const account = accounts[0] as
      | { emailVerifiedAt: string | null; ageMinutes: number }
      | undefined
    if (!account) throw new AppError('AUTH_REQUIRED', 'Authentication required', 401)
    if (!account.emailVerifiedAt)
      throw new AppError('EMAIL_VERIFICATION_REQUIRED', 'Verify your email to play', 403)
    if (Number(account.ageMinutes) < MIN_ACCOUNT_AGE_MINUTES)
      throw new AppError(
        'ACCOUNT_TOO_NEW',
        `New accounts can play after ${MIN_ACCOUNT_AGE_MINUTES} minutes`,
        403,
      )

    const [limitRows] = await connection.execute<RowDataPacket[]>(
      `SELECT daily_entry_limit AS dailyEntryLimit,
        CAST(daily_loss_limit AS CHAR) AS dailyLossLimit,
        self_excluded_until AS selfExcludedUntil,
        self_excluded_until > NOW(6) AS excluded
       FROM arcade_limits WHERE user_id = ? FOR UPDATE`,
      [userId],
    )
    const limits = limitRows[0]
    if (!limits) return

    if (Number(limits.excluded) === 1)
      throw new AppError(
        'SELF_EXCLUDED',
        'You have excluded yourself from the Arcade until ' +
          String(limits.selfExcludedUntil),
        403,
      )

    const entryLimit = limits.dailyEntryLimit as number | null
    if (entryLimit !== null) {
      const [entries] = await connection.execute<RowDataPacket[]>(
        `SELECT COUNT(*) AS played FROM arcade_entries
         WHERE user_id = ? AND joined_at >= DATE_SUB(NOW(6), INTERVAL 1 DAY)`,
        [userId],
      )
      if (Number(entries[0]?.played ?? 0) >= entryLimit)
        throw new AppError(
          'ENTRY_LIMIT_REACHED',
          'You have reached the number of rounds you set for yourself today',
          403,
        )
    }

    const lossLimit = limits.dailyLossLimit as string | null
    if (lossLimit !== null && stake) {
      // Net position over the window: stakes are negative, payouts and refunds
      // positive, so a losing day sums below zero.
      const [ledger] = await connection.execute<RowDataPacket[]>(
        `SELECT CAST(COALESCE(SUM(amount), 0) AS CHAR) AS net FROM arcade_ledger
         WHERE user_id = ? AND asset = ? AND entry_type <> 'deposit'
           AND created_at >= DATE_SUB(NOW(6), INTERVAL 1 DAY)`,
        [userId, stake.asset],
      )
      const net = String(ledger[0]?.net ?? '0')
      const lost = net.startsWith('-') ? net.slice(1) : '0'
      // The stake about to be taken counts toward the limit, so the limit
      // stops the round that would breach it rather than reporting it after.
      if (compare(addAmounts(lost, stake.amount), lossLimit) > 0)
        throw new AppError(
          'LOSS_LIMIT_REACHED',
          'This round would pass the daily loss limit you set for yourself',
          403,
        )
    }
  }
}

function addAmounts(left: string, right: string): string {
  // Reuses the ledger's scaling rather than a float add.
  const scale = (value: string): bigint => {
    const [whole = '0', fraction = ''] = value.split('.')
    return BigInt(whole + fraction.padEnd(18, '0').slice(0, 18))
  }
  const total = (scale(left) + scale(right)).toString().padStart(19, '0')
  const fraction = total.slice(-18).replace(/0+$/, '')
  return `${total.slice(0, -18)}${fraction ? `.${fraction}` : ''}`
}

/** A self-exclusion can be extended but never shortened. */
function laterOf(current: string | null, next: string | null): string | null {
  if (!current) return next
  if (!next) return current
  return new Date(next) > new Date(current) ? next : current
}
