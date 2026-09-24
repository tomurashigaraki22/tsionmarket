import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { asyncHandler } from '../../utils/asyncHandler.js'
import { requireIdentity } from '../../auth/middleware.js'
import type { ArcadeRepository } from '../../arcade/ArcadeRepository.js'
import type { RoundRepository } from '../../arcade/RoundRepository.js'

export const commitSchema = z.object({ choice: z.union([z.literal(0), z.literal(1)]) }).strict()

const LAST_MAN = 'last-man'
const JOIN_WINDOW_SECONDS = 45
const TICK_SECONDS = 15
const MIN_PLAYERS = 3
const MAX_PLAYERS = 100
// A tick is seconds long, so the stream reads more often than the game moves.
const STREAM_POLL_MS = 1_000
const STREAM_HEARTBEAT_MS = 15_000

/**
 * The catalogue is public; everything that touches a round is not, and is
 * mounted behind the authenticated boundary by app.ts.
 */
export function arcadeCatalogueRouter(repo: ArcadeRepository) {
  const router = Router()
  router.get(
    '/arcade/games',
    asyncHandler(async (_req, res) =>
      res.json({ success: true, data: { items: await repo.listGames() } }),
    ),
  )
  return router
}

export function arcadeRoundsRouter(rounds: RoundRepository) {
  const router = Router()
  // A commit is one small write per player per tick, so the limit only exists
  // to stop a loop hammering the endpoint between deadlines.
  const playLimit = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  })

  router.get(
    '/arcade/last-man/rounds',
    asyncHandler(async (_req, res) =>
      res.json({ success: true, data: { items: await rounds.openRounds(LAST_MAN) } }),
    ),
  )

  // Opens a round if none is taking players. Idempotent under lock, so two
  // people arriving together get one round rather than two half-full ones.
  router.post(
    '/arcade/last-man/rounds',
    playLimit,
    asyncHandler(async (_req, res) => {
      const round = await rounds.ensureOpenRound({
        gameId: LAST_MAN,
        joinWindowSeconds: JOIN_WINDOW_SECONDS,
        tickSeconds: TICK_SECONDS,
        minPlayers: MIN_PLAYERS,
        maxPlayers: MAX_PLAYERS,
      })
      res.status(201).json({ success: true, data: round })
    }),
  )

  router.post(
    '/arcade/rounds/:roundId/join',
    playLimit,
    asyncHandler(async (req, res) => {
      const id = z.string().uuid().parse(req.params.roundId)
      await rounds.join(id, requireIdentity(req).userId)
      res.json({ success: true, data: await rounds.view(id, requireIdentity(req).userId) })
    }),
  )

  router.post(
    '/arcade/rounds/:roundId/commit',
    playLimit,
    asyncHandler(async (req, res) => {
      const id = z.string().uuid().parse(req.params.roundId)
      const input = commitSchema.parse(req.body)
      const userId = requireIdentity(req).userId
      await rounds.commit(id, userId, input.choice)
      res.json({ success: true, data: await rounds.view(id, userId) })
    }),
  )

  /**
   * The round, pushed as it changes.
   *
   * A tick is resolved by the worker on the server's clock, so a client that
   * polls learns about its own elimination up to a poll late. This sends the
   * view whenever it changes and nothing when it has not.
   *
   * It sends the same view the GET returns — one player's own state and the
   * counts — never anyone else's pending choice, which would make the stream
   * a way to win the game.
   *
   * Authenticated by the Authorization header like every other /v1 route,
   * which is why the frontend uses a fetch-based SSE client rather than
   * EventSource. Registered on a deeper path than '/arcade/rounds/:roundId',
   * so neither shadows the other.
   */
  router.get(
    '/arcade/rounds/:roundId/stream',
    asyncHandler(async (req, res) => {
      const id = z.string().uuid().parse(req.params.roundId)
      const userId = requireIdentity(req).userId

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.write('retry: 2000\n\n')

      let closed = false
      req.on('close', () => {
        closed = true
      })

      const heartbeat = setInterval(() => {
        if (!closed) res.write(':hb\n\n')
      }, STREAM_HEARTBEAT_MS)

      let previous = ''
      try {
        while (!closed) {
          const view = await rounds.view(id, userId)
          const encoded = JSON.stringify(view)
          // Only write on a change. A tick is seconds long and the view is
          // identical between them; resending it would be a heartbeat with
          // extra steps.
          if (encoded !== previous) {
            previous = encoded
            res.write(`event: round\ndata: ${encoded}\n\n`)
          }
          // A settled round has nothing further to say.
          if (view.round.status === 'settled' || view.round.status === 'aborted') break
          await new Promise((resolve) => setTimeout(resolve, STREAM_POLL_MS))
        }
      } finally {
        clearInterval(heartbeat)
        res.end()
      }
    }),
  )

  router.get(
    '/arcade/rounds/:roundId',
    asyncHandler(async (req, res) => {
      const id = z.string().uuid().parse(req.params.roundId)
      res.json({ success: true, data: await rounds.view(id, requireIdentity(req).userId) })
    }),
  )

  return router
}
