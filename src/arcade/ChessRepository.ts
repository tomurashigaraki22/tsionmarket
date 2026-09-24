import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Chess, type Color } from 'chess.js'
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import { fromMysqlDateTime } from '../db/datetime.js'
import { withTransaction } from '../db/transaction.js'
import { AppError } from '../utils/errors.js'
import {
  applyChessMove,
  CHESS_START_FEN,
  finalizeChessPgn,
  timeoutOutcome,
  type ChessMoveIntent,
} from './chess.js'

const INVITE_TTL_MS = 24 * 60 * 60 * 1000
const MOVE_INCREMENT_MS = 0

type MatchStatus = 'waiting' | 'active' | 'complete' | 'cancelled' | 'declined' | 'expired'
type MatchRow = RowDataPacket & {
  id: string
  createdBy: string
  whiteUserId: string
  blackUserId: string | null
  inviteTokenHash: string | null
  inviteExpiresAt: string | null
  status: MatchStatus
  fen: string
  pgn: string
  version: number
  timeControlSeconds: number
  whiteTimeMs: number
  blackTimeMs: number
  turnStartedAt: string | null
  drawOfferedBy: string | null
  result: '1-0' | '0-1' | '1/2-1/2' | null
  termination: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

type MoveRow = RowDataPacket & {
  version: number
  color: Color
  from: string
  to: string
  promotion: string | null
  captured: string | null
  san: string
}

const MATCH_COLUMNS = `id, created_by AS createdBy, white_user_id AS whiteUserId,
  black_user_id AS blackUserId, invite_token_hash AS inviteTokenHash,
  invite_expires_at AS inviteExpiresAt, status, fen, pgn, version,
  time_control_seconds AS timeControlSeconds,
  white_time_ms AS whiteTimeMs, black_time_ms AS blackTimeMs,
  turn_started_at AS turnStartedAt, draw_offered_by AS drawOfferedBy,
  result, termination, created_at AS createdAt, started_at AS startedAt,
  completed_at AS completedAt`

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function numberValue(value: unknown): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0)
    throw new AppError('CHESS_STATE_INVALID', 'The stored match clock is invalid', 500)
  return result
}

function currentTurn(fen: string): Color {
  const active = fen.split(' ')[1]
  if (active !== 'w' && active !== 'b')
    throw new AppError('CHESS_STATE_INVALID', 'The stored match position is invalid', 500)
  return active
}

function hasExpired(row: MatchRow, now = Date.now()): boolean {
  if (!row.inviteExpiresAt) return false
  return fromMysqlDateTime(row.inviteExpiresAt).getTime() <= now
}

function clockSnapshot(row: MatchRow, now = Date.now()) {
  const turn = currentTurn(row.fen)
  let whiteMs = numberValue(row.whiteTimeMs)
  let blackMs = numberValue(row.blackTimeMs)
  if (row.status === 'active' && !row.turnStartedAt)
    throw new AppError('CHESS_STATE_INVALID', 'The active match clock is missing its start time', 500)
  if (row.status === 'active' && row.turnStartedAt) {
    const elapsed = Math.max(0, now - fromMysqlDateTime(row.turnStartedAt).getTime())
    if (turn === 'w') whiteMs = Math.max(0, whiteMs - elapsed)
    else blackMs = Math.max(0, blackMs - elapsed)
  }
  return { whiteMs, blackMs, turn }
}

export class ChessRepository {
  constructor(private readonly pool: Pool) {}

  /** The invite token is returned exactly once; only its SHA-256 digest is stored. */
  async createInvite(userId: string, timeControlSeconds: number) {
    const id = randomUUID()
    const token = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS)
    const initialTimeMs = timeControlSeconds * 1000
    await this.pool.execute(
      `INSERT INTO chess_matches
        (id, created_by, white_user_id, invite_token_hash, invite_expires_at,
         status, fen, pgn, version, time_control_seconds, white_time_ms, black_time_ms)
       VALUES (?, ?, ?, ?, ?, 'waiting', ?, '', 0, ?, ?, ?)`,
      [
        id,
        userId,
        userId,
        tokenHash(token),
        expiresAt,
        CHESS_START_FEN,
        timeControlSeconds,
        initialTimeMs,
        initialTimeMs,
      ],
    )
    return {
      matchId: id,
      inviteToken: token,
      expiresAt: expiresAt.toISOString(),
      timeControlSeconds,
      stake: null,
    }
  }

  async invitePreview(token: string) {
    const [rows] = await this.pool.execute<MatchRow[]>(
      `SELECT ${MATCH_COLUMNS} FROM chess_matches WHERE invite_token_hash = ?`,
      [tokenHash(token)],
    )
    const row = rows[0]
    if (!row)
      throw new AppError('CHESS_INVITE_NOT_FOUND', 'That chess invitation is invalid or already used', 404)
    return {
      matchId: row.id,
      status: hasExpired(row) && row.status === 'waiting' ? 'expired' : row.status,
      timeControlSeconds: Number(row.timeControlSeconds),
      stake: null,
      terms: `${Number(row.timeControlSeconds) / 60}-minute clock · no entry fee · no prize or payout`,
    }
  }

  async listForUser(userId: string, limit: number) {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT m.id, m.status,
         IF(m.white_user_id = ?, 'w', 'b') AS myColor,
         (m.black_user_id IS NOT NULL) AS opponentJoined,
         m.result, m.termination, m.time_control_seconds AS timeControlSeconds,
         (SELECT COUNT(*) FROM chess_moves cm WHERE cm.match_id = m.id) AS moveCount,
         COALESCE(
           m.completed_at,
           (SELECT MAX(cm.created_at) FROM chess_moves cm WHERE cm.match_id = m.id),
           m.started_at,
           m.created_at
         ) AS lastActivityAt
       FROM chess_matches m
       WHERE m.white_user_id = ? OR m.black_user_id = ?
       ORDER BY lastActivityAt DESC
       LIMIT ?`,
      [userId, userId, userId, limit],
    )
    return {
      items: rows.map((row) => ({
        id: String(row.id),
        status: String(row.status) as MatchStatus,
        myColor: String(row.myColor) as Color,
        opponentJoined: Boolean(row.opponentJoined),
        result: (row.result as MatchRow['result']) ?? null,
        termination: (row.termination as string | null) ?? null,
        timeControlSeconds: Number(row.timeControlSeconds),
        moveCount: Number(row.moveCount),
        lastActivityAt: fromMysqlDateTime(String(row.lastActivityAt)).toISOString(),
      })),
    }
  }

  async acceptInvite(token: string, userId: string) {
    const outcome = await withTransaction(this.pool, async (connection) => {
      const row = await this.findInvite(connection, token, true)
      if (!row)
        throw new AppError('CHESS_INVITE_NOT_FOUND', 'That chess invitation is invalid or already used', 404)
      if (row.status !== 'waiting')
        throw new AppError('CHESS_INVITE_CLOSED', 'That chess invitation is no longer open', 409)
      if (hasExpired(row)) {
        await connection.execute(
          `UPDATE chess_matches SET status = 'expired', invite_token_hash = NULL,
           invite_expires_at = NULL WHERE id = ? AND status = 'waiting'`,
          [row.id],
        )
        return { expired: true as const, matchId: row.id }
      }
      if (row.createdBy === userId)
        throw new AppError('CHESS_SELF_INVITE', 'You cannot accept your own invitation', 409)

      await connection.execute(
        `UPDATE chess_matches SET black_user_id = ?, status = 'active',
           invite_token_hash = NULL, invite_expires_at = NULL,
           started_at = UTC_TIMESTAMP(6), turn_started_at = UTC_TIMESTAMP(6)
         WHERE id = ? AND status = 'waiting'`,
        [userId, row.id],
      )
      return { expired: false as const, matchId: row.id }
    })
    if (outcome.expired) throw new AppError('CHESS_INVITE_EXPIRED', 'That chess invitation has expired', 410)
    return this.view(outcome.matchId, userId)
  }

  async declineInvite(token: string, userId: string): Promise<void> {
    const outcome = await withTransaction(this.pool, async (connection) => {
      const row = await this.findInvite(connection, token, true)
      if (!row)
        throw new AppError('CHESS_INVITE_NOT_FOUND', 'That chess invitation is invalid or already used', 404)
      if (row.status !== 'waiting')
        throw new AppError('CHESS_INVITE_CLOSED', 'That chess invitation is no longer open', 409)
      if (row.createdBy === userId)
        throw new AppError('CHESS_SELF_INVITE', 'You cannot decline your own invitation', 409)
      if (hasExpired(row)) {
        await connection.execute(
          `UPDATE chess_matches SET status = 'expired', invite_token_hash = NULL,
           invite_expires_at = NULL WHERE id = ? AND status = 'waiting'`,
          [row.id],
        )
        return 'expired' as const
      }
      await connection.execute(
        `UPDATE chess_matches SET status = 'declined', invite_token_hash = NULL,
         invite_expires_at = NULL WHERE id = ? AND status = 'waiting'`,
        [row.id],
      )
      return 'declined' as const
    })
    if (outcome === 'expired')
      throw new AppError('CHESS_INVITE_EXPIRED', 'That chess invitation has expired', 410)
  }

  async cancelInvite(matchId: string, userId: string): Promise<void> {
    await withTransaction(this.pool, async (connection) => {
      const row = await this.findMatch(connection, matchId, true)
      if (!row) throw new AppError('CHESS_MATCH_NOT_FOUND', 'That chess match could not be found', 404)
      if (row.createdBy !== userId)
        throw new AppError(
          'CHESS_NOT_MATCH_OWNER',
          'Only the player who created this invitation can cancel it',
          403,
        )
      if (row.status !== 'waiting')
        throw new AppError('CHESS_INVITE_CLOSED', 'Only an unaccepted invitation can be cancelled', 409)
      await connection.execute(
        `UPDATE chess_matches SET status = 'cancelled', invite_token_hash = NULL,
         invite_expires_at = NULL WHERE id = ?`,
        [matchId],
      )
    })
  }

  async view(matchId: string, userId: string) {
    return withTransaction(this.pool, async (connection) => {
      const row = await this.findMatch(connection, matchId, true)
      if (!row) throw new AppError('CHESS_MATCH_NOT_FOUND', 'That chess match could not be found', 404)
      if (row.whiteUserId !== userId && row.blackUserId !== userId)
        throw new AppError('CHESS_NOT_A_PLAYER', 'Only a player in this match can view it', 403)
      await this.expireOrTimeout(connection, row)
      const updated = await this.findMatch(connection, matchId, false)
      if (!updated) throw new AppError('CHESS_MATCH_NOT_FOUND', 'That chess match could not be found', 404)
      return this.viewFromConnection(connection, updated, userId)
    })
  }

  async move(matchId: string, userId: string, expectedVersion: number, intent: ChessMoveIntent) {
    return withTransaction(this.pool, async (connection) => {
      const row = await this.findMatch(connection, matchId, true)
      if (!row) throw new AppError('CHESS_MATCH_NOT_FOUND', 'That chess match could not be found', 404)
      const color = this.playerColor(row, userId)
      if (row.status !== 'active')
        throw new AppError('CHESS_MATCH_NOT_ACTIVE', 'This match is not accepting moves', 409)
      if (row.version !== expectedVersion)
        throw new AppError(
          'CHESS_STALE_POSITION',
          'The board has changed. Review the current position before moving.',
          409,
        )
      if (!row.turnStartedAt)
        throw new AppError('CHESS_STATE_INVALID', 'The active match clock is missing its start time', 500)

      if (await this.expireOrTimeout(connection, row)) {
        const updated = await this.findMatch(connection, matchId, false)
        if (!updated) throw new AppError('CHESS_MATCH_NOT_FOUND', 'That chess match could not be found', 404)
        return this.viewFromConnection(connection, updated, userId)
      }
      const turn = currentTurn(row.fen)
      if (color !== turn) throw new AppError('CHESS_OUT_OF_TURN', 'It is the other player’s turn', 409)

      const applied = applyChessMove(row.fen, row.pgn, intent)
      if (applied.color !== color)
        throw new AppError('CHESS_OUT_OF_TURN', 'It is the other player’s turn', 409)
      const nextVersion = Number(row.version) + 1
      await connection.execute(
        `INSERT INTO chess_moves
          (match_id, version, user_id, color, from_square, to_square, promotion, captured_piece, san, fen_after)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          matchId,
          nextVersion,
          userId,
          color,
          intent.from,
          intent.to,
          intent.promotion ?? null,
          applied.captured,
          applied.san,
          applied.fen,
        ],
      )
      const spent = Math.max(0, Date.now() - fromMysqlDateTime(row.turnStartedAt).getTime())
      const baseTime = numberValue(color === 'w' ? row.whiteTimeMs : row.blackTimeMs)
      const remaining = Math.max(0, baseTime - spent)
      const withIncrement = remaining + MOVE_INCREMENT_MS
      const resultValue = applied.result
      await connection.execute(
        `UPDATE chess_matches SET fen = ?, pgn = ?, version = ?,
          white_time_ms = IF(? = 'w', ?, white_time_ms),
          black_time_ms = IF(? = 'b', ?, black_time_ms),
          status = IF(? IS NULL, 'active', 'complete'), result = ?, termination = ?,
          draw_offered_by = NULL,
          turn_started_at = IF(? IS NULL, UTC_TIMESTAMP(6), NULL),
          completed_at = IF(? IS NULL, NULL, UTC_TIMESTAMP(6))
         WHERE id = ? AND status = 'active'`,
        [
          applied.fen,
          applied.pgn,
          nextVersion,
          color,
          color === 'w' ? withIncrement : 0,
          color,
          color === 'b' ? withIncrement : 0,
          applied.termination,
          resultValue,
          applied.termination,
          applied.termination,
          applied.termination,
          matchId,
        ],
      )
      const updated = await this.findMatch(connection, matchId, false)
      if (!updated) throw new AppError('CHESS_MATCH_NOT_FOUND', 'That chess match could not be found', 404)
      return this.viewFromConnection(connection, updated, userId)
    })
  }

  async resign(matchId: string, userId: string) {
    return withTransaction(this.pool, async (connection) => {
      const row = await this.findMatch(connection, matchId, true)
      if (!row) throw new AppError('CHESS_MATCH_NOT_FOUND', 'That chess match could not be found', 404)
      const color = this.playerColor(row, userId)
      if (row.status !== 'active')
        throw new AppError('CHESS_MATCH_NOT_ACTIVE', 'This match is not active', 409)
      if (await this.expireOrTimeout(connection, row)) {
        const updated = await this.findMatch(connection, matchId, false)
        if (!updated) throw new AppError('CHESS_MATCH_NOT_FOUND', 'That chess match could not be found', 404)
        return this.viewFromConnection(connection, updated, userId)
      }
      const result = color === 'w' ? '0-1' : '1-0'
      const pgn = finalizeChessPgn(row.fen, row.pgn, result, 'resignation')
      await connection.execute(
        `UPDATE chess_matches SET status = 'complete', result = ?, pgn = ?, termination = 'resignation',
         version = version + 1, completed_at = UTC_TIMESTAMP(6), turn_started_at = NULL,
         draw_offered_by = NULL WHERE id = ? AND status = 'active'`,
        [result, pgn, matchId],
      )
      const updated = await this.findMatch(connection, matchId, false)
      if (!updated) throw new AppError('CHESS_MATCH_NOT_FOUND', 'That chess match could not be found', 404)
      return this.viewFromConnection(connection, updated, userId)
    })
  }

  async offerOrAcceptDraw(matchId: string, userId: string) {
    return withTransaction(this.pool, async (connection) => {
      const row = await this.findMatch(connection, matchId, true)
      if (!row) throw new AppError('CHESS_MATCH_NOT_FOUND', 'That chess match could not be found', 404)
      this.playerColor(row, userId)
      if (row.status !== 'active')
        throw new AppError('CHESS_MATCH_NOT_ACTIVE', 'This match is not active', 409)
      if (await this.expireOrTimeout(connection, row)) {
        const updated = await this.findMatch(connection, matchId, false)
        if (!updated) throw new AppError('CHESS_MATCH_NOT_FOUND', 'That chess match could not be found', 404)
        return this.viewFromConnection(connection, updated, userId)
      }
      if (row.drawOfferedBy && row.drawOfferedBy !== userId) {
        const pgn = finalizeChessPgn(row.fen, row.pgn, '1/2-1/2', 'agreement')
        await connection.execute(
          `UPDATE chess_matches SET status = 'complete', result = '1/2-1/2', pgn = ?,
           termination = 'agreement', version = version + 1,
           completed_at = UTC_TIMESTAMP(6), turn_started_at = NULL, draw_offered_by = NULL
           WHERE id = ? AND status = 'active'`,
          [pgn, matchId],
        )
      } else {
        await connection.execute(
          `UPDATE chess_matches SET draw_offered_by = ?, version = version + 1
           WHERE id = ? AND status = 'active'`,
          [row.drawOfferedBy === userId ? null : userId, matchId],
        )
      }
      const updated = await this.findMatch(connection, matchId, false)
      if (!updated) throw new AppError('CHESS_MATCH_NOT_FOUND', 'That chess match could not be found', 404)
      return this.viewFromConnection(connection, updated, userId)
    })
  }

  /** Worker: expire waiting invites and resolve clock deadlines even without viewers. */
  async sweep(): Promise<void> {
    await this.pool.execute(
      `UPDATE chess_matches SET status = 'expired', invite_token_hash = NULL,
       invite_expires_at = NULL WHERE status = 'waiting' AND invite_expires_at <= UTC_TIMESTAMP(6)`,
    )
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT id FROM chess_matches WHERE status = 'active' AND turn_started_at IS NOT NULL
       ORDER BY turn_started_at ASC LIMIT 100`,
    )
    for (const row of rows) {
      await withTransaction(this.pool, async (connection) => {
        const match = await this.findMatch(connection, String(row.id), true)
        if (match) await this.expireOrTimeout(connection, match)
      })
    }
  }

  private async findInvite(connection: PoolConnection, token: string, lock: boolean) {
    const [rows] = await connection.execute<MatchRow[]>(
      `SELECT ${MATCH_COLUMNS} FROM chess_matches WHERE invite_token_hash = ?${lock ? ' FOR UPDATE' : ''}`,
      [tokenHash(token)],
    )
    return rows[0] ?? null
  }

  private async findMatch(connection: PoolConnection, id: string, lock: boolean) {
    const [rows] = await connection.execute<MatchRow[]>(
      `SELECT ${MATCH_COLUMNS} FROM chess_matches WHERE id = ?${lock ? ' FOR UPDATE' : ''}`,
      [id],
    )
    return rows[0] ?? null
  }

  private playerColor(row: MatchRow, userId: string): Color {
    if (row.whiteUserId === userId) return 'w'
    if (row.blackUserId === userId) return 'b'
    throw new AppError('CHESS_NOT_A_PLAYER', 'Only a player in this match can take that action', 403)
  }

  /** Returns true only when it settled a timed-out match. */
  private async expireOrTimeout(connection: PoolConnection, row: MatchRow): Promise<boolean> {
    if (row.status === 'waiting' && hasExpired(row)) {
      await connection.execute(
        `UPDATE chess_matches SET status = 'expired', invite_token_hash = NULL,
         invite_expires_at = NULL WHERE id = ? AND status = 'waiting'`,
        [row.id],
      )
      return false
    }
    if (row.status !== 'active' || !row.turnStartedAt) return false
    const turn = currentTurn(row.fen)
    const remaining = numberValue(turn === 'w' ? row.whiteTimeMs : row.blackTimeMs)
    const elapsed = Math.max(0, Date.now() - fromMysqlDateTime(row.turnStartedAt).getTime())
    if (elapsed < remaining) return false
    const { result, termination } = timeoutOutcome(row.fen)
    const pgn = finalizeChessPgn(row.fen, row.pgn, result, termination)
    await connection.execute(
      `UPDATE chess_matches SET status = 'complete', result = ?, pgn = ?, termination = ?,
       version = version + 1, white_time_ms = IF(? = 'w', 0, white_time_ms),
       black_time_ms = IF(? = 'b', 0, black_time_ms),
       completed_at = UTC_TIMESTAMP(6), turn_started_at = NULL, draw_offered_by = NULL
       WHERE id = ? AND status = 'active'`,
      [result, pgn, termination, turn, turn, row.id],
    )
    return true
  }

  private async viewFromConnection(connection: PoolConnection, row: MatchRow, userId: string) {
    const [moveRows] = await connection.execute<MoveRow[]>(
      `SELECT version, color, from_square AS \`from\`, to_square AS \`to\`,
         promotion, captured_piece AS captured, san FROM chess_moves
       WHERE match_id = ? ORDER BY version ASC`,
      [row.id],
    )
    const clocks = clockSnapshot(row)
    const mine = this.playerColor(row, userId)
    const now = new Date().toISOString()
    const game = new Chess()
    try {
      if (row.pgn) game.loadPgn(row.pgn)
      if (game.fen() !== row.fen) throw new Error('FEN and PGN do not match')
    } catch {
      throw new AppError('CHESS_STATE_INVALID', 'The stored match position is invalid', 500)
    }
    const legalMoves =
      row.status === 'active' && clocks.turn === mine
        ? game.moves({ verbose: true }).map((move) => ({
            from: move.from,
            to: move.to,
            promotion: move.promotion ?? null,
            captured: move.captured ?? null,
          }))
        : []
    return {
      id: row.id,
      status: row.status,
      fen: row.fen,
      pgn: row.pgn,
      version: Number(row.version),
      myColor: mine,
      turn: clocks.turn,
      inCheck: game.isCheck(),
      legalMoves,
      whiteTimeMs: clocks.whiteMs,
      blackTimeMs: clocks.blackMs,
      serverTime: now,
      drawOfferedByMe: row.drawOfferedBy === userId,
      drawOfferedByOpponent: Boolean(row.drawOfferedBy && row.drawOfferedBy !== userId),
      result: row.result,
      termination: row.termination,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      invitationExpiresAt: row.inviteExpiresAt ? fromMysqlDateTime(row.inviteExpiresAt).toISOString() : null,
      timeControlSeconds: Number(row.timeControlSeconds),
      stake: null,
      moves: moveRows.map((move) => ({
        version: Number(move.version),
        color: move.color,
        from: move.from,
        to: move.to,
        promotion: move.promotion,
        captured: move.captured,
        san: move.san,
      })),
    }
  }
}
