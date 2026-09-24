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

  router.get(
    '/arcade/rounds/:roundId',
    asyncHandler(async (req, res) => {
      const id = z.string().uuid().parse(req.params.roundId)
      res.json({ success: true, data: await rounds.view(id, requireIdentity(req).userId) })
    }),
  )

  return router
}
