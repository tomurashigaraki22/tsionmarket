import { Chess } from 'chess.js'
import { describe, expect, it } from 'vitest'
import { AppError } from '../src/utils/errors.js'
import { applyChessMove, CHESS_START_FEN, gameTermination, timeoutOutcome } from '../src/arcade/chess.js'

function play(fen: string, pgn: string, from: string, to: string, promotion?: 'q' | 'r' | 'b' | 'n') {
  return applyChessMove(fen, pgn, { from, to, ...(promotion ? { promotion } : {}) })
}

describe('server-authoritative chess rules', () => {
  it('starts with the standard 20 legal moves and persists canonical FEN/PGN', () => {
    const chess = new Chess(CHESS_START_FEN)
    expect(chess.moves()).toHaveLength(20)
    const next = play(CHESS_START_FEN, '', 'e2', 'e4')
    expect(next.san).toBe('e4')
    expect(next.fen).toContain(' b KQkq - ')
    expect(next.pgn).toContain('1. e4')
    expect(play(next.fen, next.pgn, 'e7', 'e5').pgn).toContain('1. e4 e5')
  })

  it('rejects illegal moves rather than allowing client-supplied board state', () => {
    try {
      play(CHESS_START_FEN, '', 'e2', 'e5')
      expect.fail('illegal move should have been rejected')
    } catch (error) {
      expect(error).toBeInstanceOf(AppError)
      expect((error as AppError).code).toBe('CHESS_ILLEGAL_MOVE')
    }
  })

  it('supports castling and en passant', () => {
    let fen = CHESS_START_FEN
    let pgn = ''
    for (const [from, to] of [
      ['e2', 'e4'],
      ['e7', 'e5'],
      ['g1', 'f3'],
      ['b8', 'c6'],
      ['f1', 'e2'],
      ['g8', 'f6'],
      ['e1', 'g1'],
    ]) {
      const move = play(fen, pgn, from!, to!)
      fen = move.fen
      pgn = move.pgn
    }
    expect(pgn).toContain('O-O')

    fen = CHESS_START_FEN
    pgn = ''
    for (const [from, to] of [
      ['e2', 'e4'],
      ['a7', 'a6'],
      ['e4', 'e5'],
      ['d7', 'd5'],
    ]) {
      const move = play(fen, pgn, from!, to!)
      fen = move.fen
      pgn = move.pgn
    }
    const enPassant = play(fen, pgn, 'e5', 'd6')
    expect(enPassant.captured).toBe('p')
    expect(enPassant.san).toBe('exd6')
  })

  it('requires an explicit promotion piece and handles promotion', () => {
    const fen = '7k/P7/8/8/8/8/8/7K w - - 0 1'
    expect(() => play(fen, '', 'a7', 'a8')).toThrow()
    const promoted = play(fen, '', 'a7', 'a8', 'q')
    expect(new Chess(promoted.fen).get('a8')).toEqual({ color: 'w', type: 'q' })
    expect(promoted.pgn).toContain('=Q')
  })

  it('recognizes checkmate, stalemate, repetition, and rule draws', () => {
    let fen = CHESS_START_FEN
    let pgn = ''
    for (const [from, to] of [
      ['f2', 'f3'],
      ['e7', 'e5'],
      ['g2', 'g4'],
      ['d8', 'h4'],
    ]) {
      const move = play(fen, pgn, from!, to!)
      fen = move.fen
      pgn = move.pgn
    }
    expect(new Chess(fen).isCheckmate()).toBe(true)
    expect(gameTermination(new Chess(fen))).toBe('checkmate')
    expect(pgn).toContain('[Result "0-1"]')

    const stalemate = new Chess('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1')
    expect(gameTermination(stalemate)).toBe('stalemate')

    fen = CHESS_START_FEN
    pgn = ''
    for (const [from, to] of [
      ['g1', 'f3'],
      ['g8', 'f6'],
      ['f3', 'g1'],
      ['f6', 'g8'],
      ['g1', 'f3'],
      ['g8', 'f6'],
      ['f3', 'g1'],
      ['f6', 'g8'],
    ]) {
      const move = play(fen, pgn, from!, to!)
      fen = move.fen
      pgn = move.pgn
    }
    const repeated = new Chess()
    repeated.loadPgn(pgn)
    expect(gameTermination(repeated)).toBe('threefold-repetition')

    const fiftyMove = new Chess('8/6pk/7p/8/8/8/6PP/6K1 w - - 100 51')
    expect(gameTermination(fiftyMove)).toBe('fifty-move-rule')
    const insufficient = new Chess('8/8/8/8/8/8/4K3/6k1 w - - 0 1')
    expect(gameTermination(insufficient)).toBe('insufficient-material')
  })

  it('awards flag fall correctly and draws when the opponent cannot possibly mate', () => {
    expect(timeoutOutcome(CHESS_START_FEN)).toEqual({ result: '0-1', termination: 'timeout' })
    expect(timeoutOutcome('8/8/8/8/8/8/4K3/6k1 w - - 0 1')).toEqual({
      result: '1/2-1/2',
      termination: 'timeout-draw',
    })
  })
})
