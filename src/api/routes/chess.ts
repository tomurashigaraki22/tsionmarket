import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { requireIdentity } from '../../auth/middleware.js'
import { CHESS_TIME_CONTROLS } from '../../arcade/chess.js'
import type { ChessRepository } from '../../arcade/ChessRepository.js'
import { asyncHandler } from '../../utils/asyncHandler.js'

const inviteTokenSchema = z
  .string()
  .min(40)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/)
const inviteBodySchema = z.object({ token: inviteTokenSchema }).strict()
const timeControlSchema = z.union([
  z.literal(CHESS_TIME_CONTROLS[0]),
  z.literal(CHESS_TIME_CONTROLS[1]),
  z.literal(CHESS_TIME_CONTROLS[2]),
])

export const createChessInviteSchema = z.object({ timeControlSeconds: timeControlSchema }).strict()
export const chessMoveSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    from: z.string().regex(/^[a-h][1-8]$/),
    to: z.string().regex(/^[a-h][1-8]$/),
    promotion: z.enum(['q', 'r', 'b', 'n']).optional(),
  })
  .strict()
  .refine((input) => input.from !== input.to, { message: 'Move squares must be different' })
export const chessMatchesQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(50).default(20) })
  .strict()

export function chessRouter(chess: ChessRepository) {
  const router = Router()
  const inviteLimit = rateLimit({
    windowMs: 60 * 60_000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  })
  const actionLimit = rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  })

  router.post(
    '/arcade/chess/invites',
    inviteLimit,
    asyncHandler(async (req, res) => {
      const input = createChessInviteSchema.parse(req.body)
      const invite = await chess.createInvite(requireIdentity(req).userId, input.timeControlSeconds)
      res.status(201).json({ success: true, data: invite })
    }),
  )

  router.post(
    '/arcade/chess/invites/preview',
    asyncHandler(async (req, res) => {
      const identity = requireIdentity(req)
      const { token } = inviteBodySchema.parse(req.body)
      res.json({ success: true, data: await chess.invitePreview(token, identity.userId) })
    }),
  )

  router.post(
    '/arcade/chess/invites/accept',
    inviteLimit,
    asyncHandler(async (req, res) => {
      const { token } = inviteBodySchema.parse(req.body)
      res.json({ success: true, data: await chess.acceptInvite(token, requireIdentity(req).userId) })
    }),
  )

  router.post(
    '/arcade/chess/invites/decline',
    inviteLimit,
    asyncHandler(async (req, res) => {
      const { token } = inviteBodySchema.parse(req.body)
      await chess.declineInvite(token, requireIdentity(req).userId)
      res.json({ success: true, data: { declined: true } })
    }),
  )

  router.post(
    '/arcade/chess/matches/:matchId/cancel',
    inviteLimit,
    asyncHandler(async (req, res) => {
      const matchId = z.string().uuid().parse(req.params.matchId)
      await chess.cancelInvite(matchId, requireIdentity(req).userId)
      res.json({ success: true, data: { cancelled: true } })
    }),
  )

  router.get(
    '/arcade/chess/matches',
    asyncHandler(async (req, res) => {
      const { limit } = chessMatchesQuerySchema.parse(req.query)
      res.json({
        success: true,
        data: await chess.listForUser(requireIdentity(req).userId, limit),
      })
    }),
  )

  router.get(
    '/arcade/chess/matches/:matchId',
    asyncHandler(async (req, res) => {
      const matchId = z.string().uuid().parse(req.params.matchId)
      res.json({ success: true, data: await chess.view(matchId, requireIdentity(req).userId) })
    }),
  )

  router.post(
    '/arcade/chess/matches/:matchId/moves',
    actionLimit,
    asyncHandler(async (req, res) => {
      const matchId = z.string().uuid().parse(req.params.matchId)
      const input = chessMoveSchema.parse(req.body)
      res.json({
        success: true,
        data: await chess.move(matchId, requireIdentity(req).userId, input.expectedVersion, input),
      })
    }),
  )

  router.post(
    '/arcade/chess/matches/:matchId/resign',
    actionLimit,
    asyncHandler(async (req, res) => {
      const matchId = z.string().uuid().parse(req.params.matchId)
      res.json({ success: true, data: await chess.resign(matchId, requireIdentity(req).userId) })
    }),
  )

  router.post(
    '/arcade/chess/matches/:matchId/draw',
    actionLimit,
    asyncHandler(async (req, res) => {
      const matchId = z.string().uuid().parse(req.params.matchId)
      res.json({ success: true, data: await chess.offerOrAcceptDraw(matchId, requireIdentity(req).userId) })
    }),
  )

  return router
}
