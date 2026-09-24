import { randomUUID } from 'node:crypto'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { AppError } from '../utils/errors.js'

export type StakeContext = {
  asset: string
  networkId: string
  amount: string
  rakeBps: number
}

/**
 * The money movements behind a round.
 *
 * Every method takes a connection rather than a pool: a stake must move in the
 * same transaction as the join that caused it, and a payout in the same
 * transaction as the settlement. A balance that changed while the round did
 * not — or the reverse — is the failure this shape makes impossible.
 *
 * Amounts are DECIMAL strings end to end. They are never parsed into a JS
 * number: 0.1 + 0.2 is not 0.3 in binary floating point, and this is money.
 */
export class StakeRepository {
  /** Credits a balance. Administrator-only today — see migration 0017. */
  async credit(
    connection: PoolConnection,
    input: { userId: string; asset: string; networkId: string; amount: string; memo?: string },
  ): Promise<void> {
    await connection.execute(
      `INSERT INTO arcade_balances (user_id, asset, network_id, available)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE available = available + VALUES(available)`,
      [input.userId, input.asset, input.networkId, input.amount],
    )
    await this.record(connection, {
      userId: input.userId,
      entryType: 'deposit',
      asset: input.asset,
      networkId: input.networkId,
      amount: input.amount,
      memo: input.memo,
    })
  }

  /**
   * Moves a stake from available into escrow.
   *
   * Charged on JOIN, not on settlement: a player who cannot pay must fail at
   * the door rather than after other people have played a round against them.
   * The row is locked first, so two joins cannot both read the same balance
   * and each decide it is sufficient.
   */
  async escrow(
    connection: PoolConnection,
    input: { userId: string; roundId: string } & Omit<StakeContext, 'rakeBps'>,
  ): Promise<void> {
    if (isZero(input.amount)) return

    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT available FROM arcade_balances
       WHERE user_id = ? AND asset = ? AND network_id = ? FOR UPDATE`,
      [input.userId, input.asset, input.networkId],
    )
    const available = String(rows[0]?.available ?? '0')
    if (compare(available, input.amount) < 0)
      throw new AppError(
        'INSUFFICIENT_GAME_BALANCE',
        `You need ${input.amount} ${input.asset} to enter this round`,
        402,
      )

    await connection.execute(
      `UPDATE arcade_balances SET available = available - ?, escrowed = escrowed + ?
       WHERE user_id = ? AND asset = ? AND network_id = ?`,
      [input.amount, input.amount, input.userId, input.asset, input.networkId],
    )
    await this.record(connection, {
      userId: input.userId,
      roundId: input.roundId,
      entryType: 'stake',
      asset: input.asset,
      networkId: input.networkId,
      amount: negate(input.amount),
    })
  }

  /** Everyone still holding a stake in this round, locked for settlement. */
  async entrants(connection: PoolConnection, roundId: string): Promise<Array<string>> {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT user_id AS userId FROM arcade_entries WHERE round_id = ? ORDER BY user_id FOR UPDATE`,
      [roundId],
    )
    return rows.map((row) => String(row.userId))
  }

  /**
   * Returns every escrowed stake in a round to the player who put it up.
   *
   * The path that must never lose money, so it is deliberately the simplest
   * one: no arithmetic beyond moving the same amount back, and it refuses to
   * run twice because the settlement row is unique.
   */
  async refundAll(
    connection: PoolConnection,
    roundId: string,
    stake: StakeContext,
  ): Promise<void> {
    if (isZero(stake.amount)) return
    if (!(await this.claimSettlement(connection, roundId, '0', '0', '0'))) return

    for (const userId of await this.entrants(connection, roundId)) {
      await connection.execute(
        `UPDATE arcade_balances SET escrowed = escrowed - ?, available = available + ?
         WHERE user_id = ? AND asset = ? AND network_id = ?`,
        [stake.amount, stake.amount, userId, stake.asset, stake.networkId],
      )
      await this.record(connection, {
        userId,
        roundId,
        entryType: 'refund',
        asset: stake.asset,
        networkId: stake.networkId,
        amount: stake.amount,
      })
    }
  }

  /**
   * Pays the pot to the winner, less rake.
   *
   * Every entrant's escrow is released — it is the pot now, not theirs — and
   * the winner is credited. The ledger rows for a round sum to zero across
   * the players and the house, which is the invariant the tests assert.
   */
  async payOut(
    connection: PoolConnection,
    roundId: string,
    winnerId: string,
    stake: StakeContext,
  ): Promise<void> {
    if (isZero(stake.amount)) return

    const entrants = await this.entrants(connection, roundId)
    const pot = multiply(stake.amount, entrants.length)
    const rake = rakeOf(pot, stake.rakeBps)
    const payout = subtract(pot, rake)

    if (!(await this.claimSettlement(connection, roundId, pot, rake, payout))) return

    for (const userId of entrants) {
      await connection.execute(
        `UPDATE arcade_balances SET escrowed = escrowed - ?
         WHERE user_id = ? AND asset = ? AND network_id = ?`,
        [stake.amount, userId, stake.asset, stake.networkId],
      )
    }

    await connection.execute(
      `INSERT INTO arcade_balances (user_id, asset, network_id, available)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE available = available + VALUES(available)`,
      [winnerId, stake.asset, stake.networkId, payout],
    )
    await this.record(connection, {
      userId: winnerId,
      roundId,
      entryType: 'payout',
      asset: stake.asset,
      networkId: stake.networkId,
      amount: payout,
    })

    if (!isZero(rake))
      await this.record(connection, {
        roundId,
        entryType: 'rake',
        asset: stake.asset,
        networkId: stake.networkId,
        amount: rake,
        memo: `${stake.rakeBps} bps`,
      })
  }

  /**
   * Claims the right to settle this round, once.
   *
   * Two workers sweeping the same due round, or one retrying after a crash,
   * both reach settlement. The unique round id means the second insert fails
   * and that caller does nothing, rather than paying the winner twice.
   */
  private async claimSettlement(
    connection: PoolConnection,
    roundId: string,
    pot: string,
    rake: string,
    paidOut: string,
  ): Promise<boolean> {
    try {
      await connection.execute(
        `INSERT INTO arcade_settlements (round_id, pot, rake, paid_out) VALUES (?, ?, ?, ?)`,
        [roundId, pot, rake, paidOut],
      )
      return true
    } catch (error) {
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY') return false
      throw error
    }
  }

  private async record(
    connection: PoolConnection,
    input: {
      userId?: string
      roundId?: string
      entryType: string
      asset: string
      networkId: string
      amount: string
      memo?: string | undefined
    },
  ): Promise<void> {
    await connection.execute(
      `INSERT INTO arcade_ledger (id, user_id, round_id, entry_type, asset, network_id, amount, memo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        input.userId ?? null,
        input.roundId ?? null,
        input.entryType,
        input.asset,
        input.networkId,
        input.amount,
        input.memo ?? null,
      ],
    )
  }
}

/*
 * Decimal helpers.
 *
 * These work on integer strings scaled by 1e18 rather than on numbers, because
 * every one of these values is money and JS numbers lose cents at scale.
 */
const SCALE = 18

function toUnits(value: string): bigint {
  const [whole = '0', fraction = ''] = value.trim().split('.')
  return BigInt(whole + fraction.padEnd(SCALE, '0').slice(0, SCALE))
}

function fromUnits(units: bigint): string {
  const negative = units < 0n
  const digits = (negative ? -units : units).toString().padStart(SCALE + 1, '0')
  const whole = digits.slice(0, -SCALE)
  const fraction = digits.slice(-SCALE).replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

export function isZero(value: string): boolean {
  return toUnits(value) === 0n
}

export function compare(left: string, right: string): number {
  const a = toUnits(left)
  const b = toUnits(right)
  return a === b ? 0 : a < b ? -1 : 1
}

export function negate(value: string): string {
  return fromUnits(-toUnits(value))
}

export function multiply(value: string, factor: number): string {
  return fromUnits(toUnits(value) * BigInt(factor))
}

export function subtract(left: string, right: string): string {
  return fromUnits(toUnits(left) - toUnits(right))
}

/** Rake rounds DOWN, so rounding can never pay the house more than the pot. */
export function rakeOf(pot: string, bps: number): string {
  return fromUnits((toUnits(pot) * BigInt(bps)) / 10_000n)
}
