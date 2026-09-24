import { randomUUID } from 'node:crypto'
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import { withTransaction } from '../db/transaction.js'
import { fromMysqlDateTime } from '../db/datetime.js'
import { AppError } from '../utils/errors.js'
import { resolveTick, type Move } from './lastMan.js'

export type RoundStatus = 'open' | 'running' | 'settled' | 'aborted'

export type Round = {
  id: string
  gameId: string
  status: RoundStatus
  currentTick: number
  tickSeconds: number
  tickDeadlineAt: string | null
  joinClosesAt: string
  minPlayers: number
  maxPlayers: number
  winnerUserId: string | null
}

const ROUND_COLUMNS = `id, game_id AS gameId, status, current_tick AS currentTick,
  tick_seconds AS tickSeconds, tick_deadline_at AS tickDeadlineAt,
  join_closes_at AS joinClosesAt, min_players AS minPlayers,
  max_players AS maxPlayers, winner_user_id AS winnerUserId`

export class RoundRepository {
  constructor(private readonly pool: Pool) {}

  async openRounds(gameId: string): Promise<Array<Round & { players: number }>> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT ${ROUND_COLUMNS},
        (SELECT COUNT(*) FROM arcade_entries e WHERE e.round_id = r.id) AS players
       FROM arcade_rounds r
       WHERE game_id = ? AND status IN ('open', 'running')
       ORDER BY join_closes_at ASC`,
      [gameId],
    )
    return rows as Array<Round & { players: number }>
  }

  async byId(id: string): Promise<Round | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT ${ROUND_COLUMNS} FROM arcade_rounds WHERE id = ?`,
      [id],
    )
    return (rows[0] as Round | undefined) ?? null
  }

  /** The round as one player sees it — never other players' pending choices. */
  async view(roundId: string, userId: string) {
    const round = await this.byId(roundId)
    if (!round) throw new AppError('ROUND_NOT_FOUND', 'That round no longer exists', 404)

    const [counts] = await this.pool.execute<RowDataPacket[]>(
      `SELECT
         SUM(status = 'alive') AS alive,
         COUNT(*) AS total
       FROM arcade_entries WHERE round_id = ?`,
      [roundId],
    )
    const [mine] = await this.pool.execute<RowDataPacket[]>(
      `SELECT status, eliminated_tick AS eliminatedTick FROM arcade_entries
       WHERE round_id = ? AND user_id = ?`,
      [roundId, userId],
    )
    const [moved] = await this.pool.execute<RowDataPacket[]>(
      `SELECT choice FROM arcade_moves WHERE round_id = ? AND tick = ? AND user_id = ?`,
      [roundId, round.currentTick, userId],
    )

    return {
      round,
      alivePlayers: Number(counts[0]?.alive ?? 0),
      totalPlayers: Number(counts[0]?.total ?? 0),
      me: mine[0]
        ? {
            status: String(mine[0].status),
            eliminatedTick: mine[0].eliminatedTick as number | null,
            // Whether this player has moved — never what anyone else chose.
            committed: Boolean(moved[0]),
          }
        : null,
    }
  }

  /**
   * Opens a round if none is currently accepting players.
   *
   * Runs in a transaction and re-checks under lock, so two people arriving at
   * an empty lobby together get one round rather than two half-full ones.
   */
  async ensureOpenRound(input: {
    gameId: string
    joinWindowSeconds: number
    tickSeconds: number
    minPlayers: number
    maxPlayers: number
  }): Promise<Round> {
    return withTransaction(this.pool, async (connection) => {
      const [existing] = await connection.execute<RowDataPacket[]>(
        `SELECT ${ROUND_COLUMNS} FROM arcade_rounds
         WHERE game_id = ? AND status = 'open' AND join_closes_at > NOW(6)
         ORDER BY join_closes_at ASC LIMIT 1 FOR UPDATE`,
        [input.gameId],
      )
      if (existing[0]) return existing[0] as Round

      const id = randomUUID()
      await connection.execute(
        `INSERT INTO arcade_rounds
          (id, game_id, status, min_players, max_players, tick_seconds, join_closes_at)
         VALUES (?, ?, 'open', ?, ?, ?, DATE_ADD(NOW(6), INTERVAL ? SECOND))`,
        [
          id,
          input.gameId,
          input.minPlayers,
          input.maxPlayers,
          input.tickSeconds,
          input.joinWindowSeconds,
        ],
      )
      const [created] = await connection.execute<RowDataPacket[]>(
        `SELECT ${ROUND_COLUMNS} FROM arcade_rounds WHERE id = ?`,
        [id],
      )
      return created[0] as Round
    })
  }

  async join(roundId: string, userId: string): Promise<void> {
    await withTransaction(this.pool, async (connection) => {
      const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT ${ROUND_COLUMNS} FROM arcade_rounds WHERE id = ? FOR UPDATE`,
        [roundId],
      )
      const round = rows[0] as Round | undefined
      if (!round) throw new AppError('ROUND_NOT_FOUND', 'That round no longer exists', 404)
      if (round.status !== 'open')
        throw new AppError('ROUND_CLOSED', 'That round has already started', 409)
      if (fromMysqlDateTime(round.joinClosesAt).getTime() <= Date.now())
        throw new AppError('ROUND_CLOSED', 'The join window has closed', 409)

      const [counts] = await connection.execute<RowDataPacket[]>(
        'SELECT COUNT(*) AS players FROM arcade_entries WHERE round_id = ?',
        [roundId],
      )
      if (Number(counts[0]?.players ?? 0) >= round.maxPlayers)
        throw new AppError('ROUND_FULL', 'That round is full', 409)

      // INSERT IGNORE against the composite key: joining twice is a no-op,
      // not a second seat.
      await connection.execute(
        'INSERT IGNORE INTO arcade_entries (round_id, user_id) VALUES (?, ?)',
        [roundId, userId],
      )
    })
  }

  /**
   * Records a choice.
   *
   * The deadline is compared against the database clock, not a timestamp the
   * client sent. The composite primary key means a second submission for the
   * same tick is refused rather than overwriting the first, so a player cannot
   * watch the count and change their mind.
   */
  async commit(roundId: string, userId: string, choice: 0 | 1): Promise<void> {
    await withTransaction(this.pool, async (connection) => {
      const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT ${ROUND_COLUMNS}, NOW(6) AS serverNow FROM arcade_rounds WHERE id = ?`,
        [roundId],
      )
      const round = rows[0] as (Round & { serverNow: string }) | undefined
      if (!round) throw new AppError('ROUND_NOT_FOUND', 'That round no longer exists', 404)
      if (round.status !== 'running')
        throw new AppError('ROUND_NOT_RUNNING', 'That round is not in play', 409)
      if (
        round.tickDeadlineAt &&
        fromMysqlDateTime(round.serverNow).getTime() >
          fromMysqlDateTime(round.tickDeadlineAt).getTime()
      )
        throw new AppError('TICK_CLOSED', 'The deadline for this tick has passed', 409)

      const [entry] = await connection.execute<RowDataPacket[]>(
        `SELECT status FROM arcade_entries WHERE round_id = ? AND user_id = ?`,
        [roundId, userId],
      )
      if (!entry[0]) throw new AppError('NOT_IN_ROUND', 'You are not in this round', 403)
      if (String(entry[0].status) !== 'alive')
        throw new AppError('ELIMINATED', 'You are out of this round', 409)

      try {
        await connection.execute(
          'INSERT INTO arcade_moves (round_id, tick, user_id, choice) VALUES (?, ?, ?, ?)',
          [roundId, round.currentTick, userId, choice],
        )
      } catch (error) {
        if ((error as { code?: string }).code === 'ER_DUP_ENTRY')
          throw new AppError('ALREADY_COMMITTED', 'You have already moved this tick', 409)
        throw error
      }
    })
  }

  /** Rounds the worker needs to act on: join window elapsed, or tick expired. */
  async dueRounds(limit: number): Promise<Array<Round>> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT ${ROUND_COLUMNS} FROM arcade_rounds
       WHERE (status = 'open' AND join_closes_at <= NOW(6))
          OR (status = 'running' AND tick_deadline_at <= NOW(6))
       ORDER BY COALESCE(tick_deadline_at, join_closes_at) ASC
       LIMIT ?`,
      [limit],
    )
    return rows as Array<Round>
  }

  /**
   * Advances one round by one step, under lock.
   *
   * Everything a step touches moves in a single transaction: a partially
   * resolved tick — some players eliminated, the tick not advanced — is the
   * one state this must never leave behind.
   */
  async advance(roundId: string): Promise<void> {
    await withTransaction(this.pool, async (connection) => {
      const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT ${ROUND_COLUMNS}, NOW(6) AS serverNow FROM arcade_rounds
         WHERE id = ? FOR UPDATE`,
        [roundId],
      )
      const round = rows[0] as (Round & { serverNow: string }) | undefined
      if (!round) return

      if (round.status === 'open') {
        await this.startOrAbort(connection, round)
        return
      }
      if (round.status !== 'running') return
      // Another worker pass may have advanced this already.
      if (
        round.tickDeadlineAt &&
        fromMysqlDateTime(round.serverNow).getTime() <
          fromMysqlDateTime(round.tickDeadlineAt).getTime()
      )
        return

      await this.resolveCurrentTick(connection, round)
    })
  }

  private async startOrAbort(connection: PoolConnection, round: Round): Promise<void> {
    const [counts] = await connection.execute<RowDataPacket[]>(
      'SELECT COUNT(*) AS players FROM arcade_entries WHERE round_id = ?',
      [round.id],
    )
    const players = Number(counts[0]?.players ?? 0)

    // Too few to play. Aborting refunds rather than running a round one person
    // would win by default.
    if (players < round.minPlayers) {
      await connection.execute(
        `UPDATE arcade_rounds SET status = 'aborted', settled_at = NOW(6) WHERE id = ?`,
        [round.id],
      )
      await connection.execute(
        `UPDATE arcade_entries SET status = 'refunded' WHERE round_id = ?`,
        [round.id],
      )
      return
    }

    await connection.execute(
      `UPDATE arcade_rounds
       SET status = 'running', started_at = NOW(6), current_tick = 1,
           tick_deadline_at = DATE_ADD(NOW(6), INTERVAL ? SECOND)
       WHERE id = ?`,
      [round.tickSeconds, round.id],
    )
  }

  private async resolveCurrentTick(
    connection: PoolConnection,
    round: Round,
  ): Promise<void> {
    const [aliveRows] = await connection.execute<RowDataPacket[]>(
      `SELECT user_id AS userId FROM arcade_entries
       WHERE round_id = ? AND status = 'alive' FOR UPDATE`,
      [round.id],
    )
    const alive = aliveRows.map((row) => String(row.userId))

    const [moveRows] = await connection.execute<RowDataPacket[]>(
      `SELECT user_id AS userId, choice FROM arcade_moves WHERE round_id = ? AND tick = ?`,
      [round.id, round.currentTick],
    )
    const moves: Array<Move> = moveRows.map((row) => ({
      userId: String(row.userId),
      choice: Number(row.choice) === 1 ? 1 : 0,
    }))

    const outcome = resolveTick(alive, moves)

    if (outcome.eliminated.length > 0) {
      const placeholders = outcome.eliminated.map(() => '?').join(',')
      await connection.execute(
        `UPDATE arcade_entries SET status = 'eliminated', eliminated_tick = ?
         WHERE round_id = ? AND user_id IN (${placeholders})`,
        [round.currentTick, round.id, ...outcome.eliminated],
      )
    }

    // Everyone went silent. Nobody played, so nobody won — the round is
    // aborted and the survivors of the previous tick get their stake back.
    if (outcome.survivors.length === 0) {
      await connection.execute(
        `UPDATE arcade_rounds SET status = 'aborted', settled_at = NOW(6) WHERE id = ?`,
        [round.id],
      )
      return
    }

    const winner = outcome.survivors[0]
    if (outcome.survivors.length === 1 && winner) {
      await connection.execute(
        `UPDATE arcade_entries SET status = 'won' WHERE round_id = ? AND user_id = ?`,
        [round.id, winner],
      )
      await connection.execute(
        `UPDATE arcade_rounds SET status = 'settled', settled_at = NOW(6), winner_user_id = ?
         WHERE id = ?`,
        [winner, round.id],
      )
      return
    }

    // The tick number always advances, including when nobody was eliminated.
    // Holding it for a replay would re-read the same moves — the key refuses a
    // second submission for a tick already committed to — and resolve to the
    // same tie forever.
    await connection.execute(
      `UPDATE arcade_rounds
       SET current_tick = ?, tick_deadline_at = DATE_ADD(NOW(6), INTERVAL ? SECOND)
       WHERE id = ?`,
      [round.currentTick + 1, round.tickSeconds, round.id],
    )
  }
}
