import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { asyncHandler } from '../../utils/asyncHandler.js'
import { requireIdentity } from '../../auth/middleware.js'
import { AppError } from '../../utils/errors.js'
import type { ProfileRepository } from '../../social/ProfileRepository.js'
import type { FloorService } from '../../social/FloorService.js'
import { HANDLE_PATTERN, normalizeHandle } from '../../social/rules.js'

const handleSchema = z
  .string()
  .transform(normalizeHandle)
  .refine((value) => HANDLE_PATTERN.test(value), {
    message: 'Handles are 3-20 characters, using letters, numbers and underscores',
  })

export const createProfileSchema = z
  .object({
    handle: handleSchema,
    displayName: z.string().trim().min(1).max(50),
    intertrainAccountId: z.string().uuid().optional(),
  })
  .strict()

export const updateProfileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(50).optional(),
    bio: z.string().trim().max(160).nullable().optional(),
  })
  .strict()

export const feedQuerySchema = z
  .object({
    sort: z.enum(['latest', 'popular']).default('latest'),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().max(1000).optional(),
  })
  .strict()

export const createPostSchema = z
  .object({
    body: z.string().trim().min(1).max(500),
    citedMarketId: z.string().max(320).optional(),
    replyToId: z.string().uuid().optional(),
  })
  .strict()

export const reportSchema = z
  .object({
    reason: z.enum(['spam', 'scam', 'abuse', 'impersonation', 'other']),
    detail: z.string().trim().max(500).optional(),
  })
  .strict()

export function socialRouter(profiles: ProfileRepository, floor: FloorService) {
  const router = Router()

  // Claiming a handle is cheap to attempt and expensive to squat, and posting
  // is the surface spam arrives through. Phase 4 adds reporting and blocking;
  // these limits are the floor, not the whole answer.
  const claimLimit = rateLimit({
    windowMs: 60 * 60_000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  })
  const postLimit = rateLimit({
    windowMs: 60 * 60_000,
    limit: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  })
  const likeLimit = rateLimit({
    windowMs: 60 * 60_000,
    limit: 300,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  })
  // Reporting is the safety valve, so the limit only exists to stop it being
  // used as a weapon — the unique constraint already caps one per post.
  const reportLimit = rateLimit({
    windowMs: 24 * 60 * 60_000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  })

  router.get(
    '/profiles/me',
    asyncHandler(async (req, res) => {
      const profile = await profiles.byUserId(requireIdentity(req).userId)
      if (!profile) throw new AppError('PROFILE_NOT_FOUND', 'No profile yet', 404)
      res.json({ success: true, data: profile })
    }),
  )

  router.get(
    '/profiles/availability',
    asyncHandler(async (req, res) => {
      const handle = handleSchema.parse(z.string().parse(req.query.handle))
      res.json({
        success: true,
        data: {
          handle,
          available: await profiles.isAvailable(handle, requireIdentity(req).userId),
        },
      })
    }),
  )

  router.post(
    '/profiles',
    claimLimit,
    asyncHandler(async (req, res) => {
      const input = createProfileSchema.parse(req.body)
      const profile = await profiles.create({
        userId: requireIdentity(req).userId,
        handle: input.handle,
        displayName: input.displayName,
        intertrainAccountId: input.intertrainAccountId,
      })
      res.status(201).json({ success: true, data: profile })
    }),
  )

  router.patch(
    '/profiles/me/intertrain-account',
    asyncHandler(async (req, res) => {
      const input = z.object({ accountId: z.string().uuid().nullable() }).strict().parse(req.body)
      res.json({
        success: true,
        data: await profiles.linkIntertrainAccount(requireIdentity(req).userId, input.accountId),
      })
    }),
  )

  router.patch(
    '/profiles/me',
    asyncHandler(async (req, res) => {
      const input = updateProfileSchema.parse(req.body)
      res.json({
        success: true,
        data: await profiles.update(requireIdentity(req).userId, input),
      })
    }),
  )

  // Registered before '/profiles/:handle' so a literal path is never captured
  // by the parameterised one.
  router.get(
    '/profiles/:handle',
    asyncHandler(async (req, res) => {
      const profile = await profiles.byHandle(handleSchema.parse(req.params.handle))
      if (!profile) throw new AppError('PROFILE_NOT_FOUND', 'No such profile', 404)
      res.json({ success: true, data: profile })
    }),
  )

  router.get(
    '/floor/posts',
    asyncHandler(async (req, res) => {
      const query = feedQuerySchema.parse(req.query)
      res.json({
        success: true,
        data: await floor.feed(requireIdentity(req).userId, query),
      })
    }),
  )

  router.post(
    '/floor/posts',
    postLimit,
    asyncHandler(async (req, res) => {
      const input = createPostSchema.parse(req.body)
      const post = await floor.publish(requireIdentity(req).userId, input)
      res.status(201).json({ success: true, data: post })
    }),
  )

  // Registered before '/floor/posts/:postId' so these literal paths are not
  // captured by the parameterised route and parsed as post ids.
  router.get(
    '/floor/reports',
    asyncHandler(async (req, res) => {
      res.json({ success: true, data: await floor.reportQueue(requireIdentity(req).userId) })
    }),
  )

  router.post(
    '/floor/posts/:postId/like',
    likeLimit,
    asyncHandler(async (req, res) => {
      const id = z.string().uuid().parse(req.params.postId)
      await floor.setLiked(id, requireIdentity(req).userId, true)
      res.status(204).send()
    }),
  )

  router.delete(
    '/floor/posts/:postId/like',
    likeLimit,
    asyncHandler(async (req, res) => {
      const id = z.string().uuid().parse(req.params.postId)
      await floor.setLiked(id, requireIdentity(req).userId, false)
      res.status(204).send()
    }),
  )

  router.post(
    '/floor/posts/:postId/report',
    reportLimit,
    asyncHandler(async (req, res) => {
      const id = z.string().uuid().parse(req.params.postId)
      const input = reportSchema.parse(req.body)
      await floor.report(id, requireIdentity(req).userId, input.reason, input.detail)
      res.status(202).json({ success: true, data: { reported: true } })
    }),
  )

  router.post(
    '/floor/posts/:postId/dismiss-reports',
    asyncHandler(async (req, res) => {
      const id = z.string().uuid().parse(req.params.postId)
      await floor.dismissReports(id, requireIdentity(req).userId)
      res.status(204).send()
    }),
  )

  router.post(
    '/floor/blocks/:userId',
    asyncHandler(async (req, res) => {
      const target = z.string().uuid().parse(req.params.userId)
      await floor.setBlocked(requireIdentity(req).userId, target, true)
      res.status(204).send()
    }),
  )

  router.delete(
    '/floor/blocks/:userId',
    asyncHandler(async (req, res) => {
      const target = z.string().uuid().parse(req.params.userId)
      await floor.setBlocked(requireIdentity(req).userId, target, false)
      res.status(204).send()
    }),
  )

  router.get(
    '/floor/posts/:postId',
    asyncHandler(async (req, res) => {
      const id = z.string().uuid().parse(req.params.postId)
      res.json({ success: true, data: await floor.thread(id, requireIdentity(req).userId) })
    }),
  )

  router.delete(
    '/floor/posts/:postId',
    asyncHandler(async (req, res) => {
      const id = z.string().uuid().parse(req.params.postId)
      await floor.remove(id, requireIdentity(req).userId)
      res.status(204).send()
    }),
  )

  return router
}
