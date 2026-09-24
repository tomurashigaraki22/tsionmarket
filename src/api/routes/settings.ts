import { Router } from 'express'
import { z } from 'zod'
import { requireIdentity } from '../../auth/middleware.js'
import type { SettingsRepository } from '../../settings/SettingsRepository.js'
import { asyncHandler } from '../../utils/asyncHandler.js'

export const userSettingsPatchSchema = z
  .object({
    displayName: z.string().trim().max(60).optional(),
    transactionUpdatesEnabled: z.boolean().optional(),
    productUpdatesEnabled: z.boolean().optional(),
  })
  .strict()

export function settingsRouter(settings: SettingsRepository) {
  const router = Router()
  router.get(
    '/settings/me',
    asyncHandler(async (req, res) => {
      res.json({ success: true, data: await settings.get(requireIdentity(req).userId) })
    }),
  )
  router.patch(
    '/settings/me',
    asyncHandler(async (req, res) => {
      const parsed = userSettingsPatchSchema.parse(req.body)
      const patch: {
        displayName?: string
        transactionUpdatesEnabled?: boolean
        productUpdatesEnabled?: boolean
      } = {}
      if (parsed.displayName !== undefined) patch.displayName = parsed.displayName
      if (parsed.transactionUpdatesEnabled !== undefined)
        patch.transactionUpdatesEnabled = parsed.transactionUpdatesEnabled
      if (parsed.productUpdatesEnabled !== undefined)
        patch.productUpdatesEnabled = parsed.productUpdatesEnabled
      res.json({
        success: true,
        data: await settings.update(requireIdentity(req).userId, patch),
      })
    }),
  )
  return router
}
