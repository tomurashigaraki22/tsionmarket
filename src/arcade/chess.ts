import { Chess, type Color } from 'chess.js'
import { AppError } from '../utils/errors.js'

export const CHESS_START_FEN = new Chess().fen()
export const CHESS_TIME_CONTROLS = [300, 600, 900] as const
export type ChessTimeControl = (typeof CHESS_TIME_CONTROLS)[number]

export type ChessMoveIntent = {
  from: string
  to: string
  promotion?: 'q' | 'r' | 'b' | 'n' | undefined
}

export function gameTermination(chess: Chess): string | null {
  if (!chess.isGameOver()) return null
  if (chess.isCheckmate()) return 'checkmate'
  if (chess.isStalemate()) return 'stalemate'
  if (chess.isThreefoldRepetition()) return 'threefold-repetition'
  if (chess.isDrawByFiftyMoves()) return 'fifty-move-rule'
  if (chess.isInsufficientMaterial()) return 'insufficient-material'
  return 'draw'
}

/** Flag fall is a draw when the opponent has no possible mating material. */
export function timeoutOutcome(fen: string): { result: '1-0' | '0-1' | '1/2-1/2'; termination: string } {
  const chess = new Chess(fen)
  if (chess.isInsufficientMaterial()) return { result: '1/2-1/2', termination: 'timeout-draw' }
  return {
    result: chess.turn() === 'w' ? '0-1' : '1-0',
    termination: 'timeout',
  }
}

export function applyChessMove(
  fen: string,
  pgn: string,
  intent: ChessMoveIntent,
): {
  fen: string
  pgn: string
  san: string
  color: Color
  captured: string | null
  termination: string | null
  result: '1-0' | '0-1' | '1/2-1/2' | null
} {
  let chess: Chess
  try {
    if (pgn) {
      chess = new Chess()
      chess.loadPgn(pgn)
      if (chess.fen() !== fen) throw new Error('FEN and PGN do not match')
    } else {
      chess = new Chess(fen)
    }
  } catch {
    throw new AppError('CHESS_STATE_INVALID', 'The stored match position is invalid', 500)
  }
  const color = chess.turn()
  try {
    const move = chess.move({
      from: intent.from,
      to: intent.to,
      ...(intent.promotion ? { promotion: intent.promotion } : {}),
    })
    const termination = gameTermination(chess)
    const result = termination ? (chess.isCheckmate() ? (color === 'w' ? '1-0' : '0-1') : '1/2-1/2') : null
    if (result) chess.setHeader('Result', result)
    return {
      fen: chess.fen(),
      pgn: chess.pgn(),
      san: move.san,
      color,
      captured: move.captured ?? null,
      termination,
      result,
    }
  } catch {
    throw new AppError('CHESS_ILLEGAL_MOVE', 'That move is not legal in this position', 400)
  }
}

export function finalizeChessPgn(fen: string, pgn: string, result: string, termination: string): string {
  try {
    const chess = new Chess()
    if (pgn) chess.loadPgn(pgn)
    else chess.load(fen)
    if (chess.fen() !== fen) throw new Error('FEN and PGN do not match')
    chess.setHeader('Result', result)
    chess.setHeader('Termination', termination)
    return chess.pgn()
  } catch {
    throw new AppError('CHESS_STATE_INVALID', 'The stored match record is invalid', 500)
  }
}
