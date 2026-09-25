import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { requireIdentity } from '../../auth/middleware.js'
import type { OnSwitchCatalogueService } from '../../payments/onswitch/catalogue.js'
import type { OnSwitchPaymentRepository } from '../../payments/onswitch/repository.js'
import { asyncHandler } from '../../utils/asyncHandler.js'
import { AppError } from '../../utils/errors.js'

const countrySchema = z.string().regex(/^[A-Z]{2}$/)
const currencySchema = z.string().regex(/^[A-Z0-9]{3,8}$/)
const channelSchema = z.enum(['BANK', 'MOBILEMONEY'])
const directionSchema = z.enum(['ONRAMP', 'OFFRAMP'])
const holderTypeSchema = z.enum(['INDIVIDUAL', 'BUSINESS'])

export const paymentRequirementsQuerySchema = z
  .object({
    direction: directionSchema,
    country: countrySchema,
    currency: currencySchema.optional(),
    channel: channelSchema.optional(),
    holderType: holderTypeSchema.optional(),
  })
  .strict()

export const paymentInstitutionsQuerySchema = z
  .object({ country: countrySchema, currency: currencySchema.optional(), channel: channelSchema.optional() })
  .strict()

export const institutionLookupBodySchema = z
  .object({
    country: countrySchema,
    beneficiary: z
      .object({
        account_number: z.string().min(4).max(34).optional(),
        bank_code: z.string().min(1).max(24).optional(),
        mobile_network: z.string().min(1).max(48).optional(),
        phone_number: z.string().min(7).max(32).optional(),
      })
      .strict()
      .refine(
        (value) =>
          (Boolean(value.account_number) && Boolean(value.bank_code)) ||
          (Boolean(value.mobile_network) && Boolean(value.phone_number)),
        { message: 'Provide bank account and bank code, or mobile network and phone number' },
      ),
  })
  .strict()

export const paymentHistoryQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().max(1000).optional(),
  })
  .strict()

const decodedCursorSchema = z.object({ createdAt: z.string().datetime(), id: z.string().uuid() }).strict()

export function onSwitchPaymentsRouter(
  catalogue: OnSwitchCatalogueService,
  payments: OnSwitchPaymentRepository,
) {
  const router = Router()
  const catalogueLimit = rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  })
  const lookupLimit = rateLimit({
    windowMs: 10 * 60_000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  })

  router.get(
    '/payments/capabilities',
    catalogueLimit,
    asyncHandler(async (request, response) => {
      response.json({ success: true, data: await catalogue.capabilities(requireIdentity(request).userId) })
    }),
  )
  router.get(
    '/payments/requirements',
    catalogueLimit,
    asyncHandler(async (request, response) => {
      const input = paymentRequirementsQuerySchema.parse(request.query)
      response.json({ success: true, data: await catalogue.requirements(input) })
    }),
  )
  router.get(
    '/payments/institutions',
    catalogueLimit,
    asyncHandler(async (request, response) => {
      const input = paymentInstitutionsQuerySchema.parse(request.query)
      response.json({ success: true, data: await catalogue.institutions(input) })
    }),
  )
  router.post(
    '/payments/institutions/lookup',
    lookupLimit,
    asyncHandler(async (request, response) => {
      const input = institutionLookupBodySchema.parse(request.body)
      // Account numbers are only forwarded in memory for this lookup. Never
      // persist them or include the provider's unmasked response in our API.
      response.json({ success: true, data: await catalogue.lookupInstitution(input) })
    }),
  )
  router.get(
    '/payments/beneficiaries',
    asyncHandler(async (request, response) => {
      const references = await catalogue.beneficiaryReferences(requireIdentity(request).userId)
      response.json({
        success: true,
        data: references.map((reference) => ({
          id: reference.id,
          label: reference.maskedLabel,
          country: reference.country,
          currency: reference.fiatCurrency,
          channel: reference.channel,
          holderType: reference.holderType,
          createdAt: reference.createdAt,
        })),
      })
    }),
  )
  router.get(
    '/payments/beneficiaries/:beneficiaryId/refresh',
    catalogueLimit,
    asyncHandler(async (request, response) => {
      const beneficiaryId = z.string().uuid().parse(request.params.beneficiaryId)
      response.json({
        success: true,
        data: await catalogue.refreshBeneficiary(requireIdentity(request).userId, beneficiaryId),
      })
    }),
  )
  router.get(
    '/payments',
    asyncHandler(async (request, response) => {
      const query = paymentHistoryQuerySchema.parse(request.query)
      const cursor = query.cursor ? decodeCursor(query.cursor) : undefined
      const rows = await payments.listForUser(requireIdentity(request).userId, query.limit + 1, cursor)
      const hasMore = rows.length > query.limit
      const items = rows.slice(0, query.limit)
      const last = items[items.length - 1]
      response.json({
        success: true,
        data: {
          items,
          nextCursor:
            hasMore && last
              ? Buffer.from(
                  JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last.id }),
                ).toString('base64url')
              : null,
        },
      })
    }),
  )
  router.get(
    '/payments/:paymentId',
    asyncHandler(async (request, response) => {
      const paymentId = z.string().uuid().parse(request.params.paymentId)
      const payment = await payments.getForUser(requireIdentity(request).userId, paymentId)
      if (!payment) throw new AppError('PAYMENT_NOT_FOUND', 'Payment not found', 404)
      response.json({ success: true, data: payment })
    }),
  )

  return router
}

function decodeCursor(value: string): { createdAt: Date; id: string } {
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
  } catch {
    throw new AppError('VALIDATION_ERROR', 'Payment history cursor is invalid', 400)
  }
  const parsed = decodedCursorSchema.safeParse(decoded)
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Payment history cursor is invalid', 400)
  return { createdAt: new Date(parsed.data.createdAt), id: parsed.data.id }
}
