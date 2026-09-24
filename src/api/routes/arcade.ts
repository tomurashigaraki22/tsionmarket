import { Router } from 'express'
import { asyncHandler } from '../../utils/asyncHandler.js'
import type { ArcadeRepository } from '../../arcade/ArcadeRepository.js'

/**
 * The catalogue is read-only and carries nothing account-specific, so it sits
 * with the public market routes rather than behind the authenticated
 * boundary. Joining a round will not.
 */
export function arcadeRouter(repo: ArcadeRepository) {
  const router = Router()
  router.get(
    '/arcade/games',
    asyncHandler(async (_req, res) =>
      res.json({ success: true, data: { items: await repo.listGames() } }),
    ),
  )
  return router
}
