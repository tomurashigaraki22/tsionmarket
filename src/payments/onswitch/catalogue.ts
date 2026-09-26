import { z } from 'zod'
import type { Environment } from '../../config/env.js'
import { BALANCE_TOKENS, NETWORKS, enabledNetworks } from '../../portfolio/networks.js'
import { AppError } from '../../utils/errors.js'
import type { OnSwitchClient, OnSwitchEnvelope } from './client.js'
import type { OnSwitchPaymentRepository, ProviderBeneficiaryReference } from './repository.js'

const directionSchema = z.enum(['ONRAMP', 'OFFRAMP'])
const channelSchema = z.enum(['BANK', 'MOBILEMONEY'])
const holderTypeSchema = z.enum(['INDIVIDUAL', 'BUSINESS'])

const coverageSchema = z.array(
  z.object({
    country: z.string().regex(/^[A-Z]{2}$/),
    currency: z.array(z.string().regex(/^[A-Z0-9]{3,8}$/)).max(20),
    continent: z.string().max(40),
    default_channel: channelSchema,
    channel: z.array(channelSchema).max(8),
    direction: z.array(directionSchema).max(4),
    settlement_time: z.record(z.string(), z.string().max(160)).optional(),
    payout_limit: z.record(z.string(), z.unknown()).optional(),
  }),
)

const providerAssetSchema = z.array(
  z.object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(160),
    code: z.string().min(1).max(24),
    decimals: z.number().int().min(0).max(36),
    address: z.string().min(1).max(160),
    blockchain: z.object({ id: z.number().int(), name: z.string().min(1).max(100) }),
    offramp_supported: z.boolean().optional().default(false),
    onramp_supported: z.boolean().optional().default(false),
    swap_supported: z.boolean().optional().default(false),
    wallet_supported: z.boolean().optional().default(false),
  }),
)

const providerRequirementSchema = z.array(
  z.object({
    path: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z][a-zA-Z0-9_.-]*(\[\])?$/),
    regex: z.string().min(1).max(256),
    example: z.string().max(128),
    required: z.boolean().optional(),
    hint: z.string().max(256).optional(),
    option: z
      .array(
        z.object({
          name: z.string().min(1).max(160),
          code: z.string().min(1).max(128),
        }),
      )
      .optional(),
  }),
)

const requirementSchema = z.array(
  z
    .object({
      path: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[a-zA-Z][a-zA-Z0-9_.-]*(\[\])?$/),
      regex: z.string().min(1).max(256),
      example: z.string().max(128),
      required: z.boolean(),
      hint: z.string().max(256).optional(),
      option: z
        .array(
          z.object({
            name: z.string().min(1).max(160),
            code: z.string().min(1).max(128),
          }),
        )
        .optional(),
    })
    .strict()
    .superRefine((field, context) => {
      if (!isSafeProviderPattern(field.regex))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['regex'],
          message: 'Unsafe provider validation pattern',
        })
    }),
)

const providerInstitutionSchema = z.array(
  z.object({
    code: z.string().min(1).max(80),
    name: z.string().min(1).max(160),
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
  }),
)

const institutionSchema = z.array(
  z.object({
    code: z.string().min(1).max(80),
    name: z.string().min(1).max(160),
    country: z.string().regex(/^[A-Z]{2}$/),
  }),
)

const beneficiaryPageSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1).max(128),
      reference: z.string().max(128),
      name: z.string().max(200),
      category: holderTypeSchema,
      channel: z.string().max(32),
      country: z.string().max(2).nullable().optional(),
      currency: z.string().max(8).nullable().optional(),
    }),
  ),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  pages: z.number().int().nonnegative(),
})

export type NormalizedCoverage = {
  country: string
  currencies: string[]
  channels: Array<'BANK' | 'MOBILEMONEY'>
  directions: Array<'ONRAMP' | 'OFFRAMP'>
  settlementTimes: Record<string, string>
  payoutLimits: Record<string, { min?: string | undefined; max?: string | undefined } | string>
  note?: string | undefined
}

export type OnSwitchCatalogueClient = Pick<OnSwitchClient, 'get' | 'post'>

type CacheEnvelope<T> = { data: T; asOf: string; stale: boolean }

export class OnSwitchCatalogueService {
  private readonly inFlight = new Map<string, Promise<CacheEnvelope<unknown>>>()

  constructor(
    private readonly client: OnSwitchCatalogueClient | null,
    private readonly repository: Pick<
      OnSwitchPaymentRepository,
      'getCatalogueCache' | 'setCatalogueCache' | 'verifiedEnabledNetworks' | 'listBeneficiaryReferences'
    >,
    private readonly environment: Environment,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async capabilities(userId: string) {
    this.assertEnabled()
    const [onramp, offramp, providerAssets, verifiedNetworks] = await Promise.all([
      this.coverage('ONRAMP'),
      this.coverage('OFFRAMP'),
      this.assets(),
      this.repository.verifiedEnabledNetworks(userId),
    ])

    const enabledByMode = new Set(
      enabledNetworks(this.environment.NETWORK_MODE).map((network) => network.networkId),
    )
    const verified = new Set(verifiedNetworks.filter((id) => enabledByMode.has(id)))
    const coverageOn = onramp.data
    const coverageOff = offramp.data
    const onrampStartsEnabled = this.environment.ONSWITCH_ONRAMP_STARTS_ENABLED
    const offrampStartsEnabled = this.environment.ONSWITCH_OFFRAMP_STARTS_ENABLED
    const assets = providerAssets.data
      .map((asset) => mapTrustedAsset(asset, verified))
      .filter((asset): asset is NonNullable<typeof asset> => asset !== null)
      .map((asset) => ({
        ...asset,
        onrampAvailable:
          onrampStartsEnabled &&
          asset.providerOnramp &&
          coverageOn.some((corridor) => corridor.directions.includes('ONRAMP')),
        offrampAvailable:
          offrampStartsEnabled &&
          asset.providerOfframp &&
          coverageOff.some((corridor) => corridor.directions.includes('OFFRAMP')),
      }))
      .filter((asset) => asset.onrampAvailable || asset.offrampAvailable)

    return {
      enabled: true,
      onrampStartsEnabled,
      offrampStartsEnabled,
      asOf: minIso(onramp.asOf, offramp.asOf, providerAssets.asOf),
      stale: onramp.stale || offramp.stale || providerAssets.stale,
      verifiedNetworks: [...verified],
      coverage: { onramp: coverageOn, offramp: coverageOff },
      assets,
    }
  }

  async requireAvailableSelection(input: {
    userId: string
    operationType: 'onramp' | 'offramp'
    country: string
    currency: string
    channel: 'BANK' | 'MOBILEMONEY'
    assetKey: string
  }) {
    const capabilities = await this.capabilities(input.userId)
    if (capabilities.stale)
      throw new AppError('PAYMENT_CATALOGUE_STALE', 'Payment options are refreshing; try again shortly', 503)
    const direction = input.operationType === 'onramp' ? 'ONRAMP' : 'OFFRAMP'
    const startsEnabled =
      input.operationType === 'onramp'
        ? this.environment.ONSWITCH_ONRAMP_STARTS_ENABLED
        : this.environment.ONSWITCH_OFFRAMP_STARTS_ENABLED
    if (!startsEnabled)
      throw new AppError(
        'PAYMENT_DIRECTION_PAUSED',
        'New payments in this direction are temporarily paused. Existing payments remain available.',
        503,
      )
    const corridors = direction === 'ONRAMP' ? capabilities.coverage.onramp : capabilities.coverage.offramp
    const corridor = corridors.find(
      (corridor) =>
        corridor.country === input.country &&
        corridor.currencies.includes(input.currency) &&
        corridor.channels.includes(input.channel) &&
        corridor.directions.includes(direction),
    )
    if (!corridor)
      throw new AppError('PAYMENT_CORRIDOR_UNSUPPORTED', 'This payment route is not currently supported', 400)
    const asset = capabilities.assets.find((item) => item.assetKey === input.assetKey)
    const supported =
      input.operationType === 'onramp' ? asset?.onrampAvailable === true : asset?.offrampAvailable === true
    if (!supported)
      throw new AppError(
        'PAYMENT_ASSET_UNSUPPORTED',
        'This stablecoin is not available for this wallet and route',
        400,
      )
    return { capabilities, asset, corridor }
  }

  async requirements(input: {
    direction: 'ONRAMP' | 'OFFRAMP'
    country: string
    currency?: string | undefined
    channel?: 'BANK' | 'MOBILEMONEY' | undefined
    holderType?: 'INDIVIDUAL' | 'BUSINESS' | undefined
  }): Promise<CacheEnvelope<z.infer<typeof requirementSchema>>> {
    this.assertEnabled()
    const query = {
      direction: input.direction,
      country: input.country,
      ...(input.currency ? { currency: input.currency } : {}),
      ...(input.channel ? { channel: input.channel } : {}),
      ...(input.holderType ? { type: input.holderType } : {}),
    }
    const key = `requirements:${Object.entries(query)
      .map(([name, value]) => `${name}=${value}`)
      .join('&')}`
    return this.cached(key, requirementSchema, async () => {
      const response = await this.client!.get('/beneficiary/requirement', query)
      return normalizeRequirements(parseProviderData(response, providerRequirementSchema))
    })
  }

  async institutions(input: {
    country: string
    currency?: string | undefined
    channel?: 'BANK' | 'MOBILEMONEY' | undefined
  }): Promise<CacheEnvelope<z.infer<typeof institutionSchema>>> {
    this.assertEnabled()
    const query = {
      country: input.country,
      ...(input.currency ? { currency: input.currency } : {}),
      ...(input.channel ? { channel: input.channel } : {}),
    }
    const key = `institutions:${Object.entries(query)
      .map(([name, value]) => `${name}=${value}`)
      .join('&')}`
    return this.cached(key, institutionSchema, async () => {
      const response = await this.client!.get('/institution', query)
      return parseProviderData(response, providerInstitutionSchema).map((institution) => ({
        code: institution.code,
        name: institution.name,
        // Switch's institution directory omits country on each row; the list
        // is already scoped by the country query.
        country: input.country,
      }))
    })
  }

  async lookupInstitution(input: {
    country: string
    beneficiary: {
      account_number?: string | undefined
      bank_code?: string | undefined
      mobile_network?: string | undefined
      phone_number?: string | undefined
    }
  }) {
    this.assertEnabled()
    const response = await this.client!.post('/institution/lookup', input)
    const data = parseProviderObject(response)
    const accountName = boundedString(data.account_name, 160)
    const bankCode = boundedString(data.bank_code, 80)
    const accountNumber = boundedString(data.account_number, 80)
    if (!accountName && !bankCode && !accountNumber)
      throw new AppError(
        'PAYMENT_PROVIDER_INVALID_RESPONSE',
        'Payment provider returned an invalid lookup result',
        502,
      )
    return {
      accountName,
      bankCode,
      accountNumberLastFour: accountNumber ? accountNumber.slice(-4) : null,
      matched: Boolean(accountName),
    }
  }

  async beneficiaryReferences(userId: string): Promise<ProviderBeneficiaryReference[]> {
    return this.repository.listBeneficiaryReferences(userId)
  }

  async refreshBeneficiary(userId: string, localReferenceId: string) {
    this.assertEnabled()
    const owned = await this.repository.listBeneficiaryReferences(userId)
    const reference = owned.find((item) => item.id === localReferenceId)
    if (!reference) throw new AppError('PAYMENT_BENEFICIARY_NOT_FOUND', 'Saved beneficiary not found', 404)
    const key = `beneficiary:${reference.id}`
    return this.cached(key, z.object({ exists: z.boolean() }), async () => {
      const response = await this.client!.get('/beneficiary/fetch', {
        search: reference.providerBeneficiaryId,
        page: 1,
        limit: 100,
      })
      const page = parseProviderData(response, beneficiaryPageSchema)
      return {
        exists: page.data.some(
          (item) =>
            item.id === reference.providerBeneficiaryId || item.reference === reference.providerBeneficiaryId,
        ),
      }
    })
  }

  private async coverage(direction: 'ONRAMP' | 'OFFRAMP'): Promise<CacheEnvelope<NormalizedCoverage[]>> {
    return this.cached<NormalizedCoverage[]>(
      `coverage:${direction}`,
      normalizedCoverageSchema.array(),
      async () => {
        const response = await this.client!.get('/coverage', { direction })
        const providerRows = parseProviderData(response, coverageSchema)
        return providerRows.filter((row) => row.direction.includes(direction)).map(normalizeCoverage)
      },
    )
  }

  private async assets(): Promise<CacheEnvelope<z.infer<typeof providerAssetSchema>>> {
    return this.cached<z.infer<typeof providerAssetSchema>>('assets', providerAssetSchema, async () => {
      const response = await this.client!.get('/asset')
      return parseProviderData(response, providerAssetSchema)
    })
  }

  private assertEnabled(): void {
    if (!this.client || !this.environment.ONSWITCH_ENABLED)
      throw new AppError('PAYMENTS_UNAVAILABLE', 'In-app payments are not enabled', 503)
  }

  private async cached<T>(
    key: string,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    load: () => Promise<T>,
  ): Promise<CacheEnvelope<T>> {
    let previous: Awaited<ReturnType<OnSwitchPaymentRepository['getCatalogueCache']>> = null
    try {
      previous = await this.repository.getCatalogueCache(key)
    } catch {
      throw new AppError('PAYMENT_CATALOGUE_UNAVAILABLE', 'Payment options are temporarily unavailable', 503)
    }
    if (previous) {
      const parsed = schema.safeParse(previous.payload)
      if (parsed.success && previous.expiresAt.getTime() > this.now().getTime())
        return { data: parsed.data, asOf: previous.fetchedAt.toISOString(), stale: false }
    }

    const active = this.inFlight.get(key)
    if (active) {
      const shared = await active
      return { data: schema.parse(shared.data), asOf: shared.asOf, stale: shared.stale }
    }

    const task = (async () => {
      try {
        const data = schema.parse(await load())
        const stored = await this.repository.setCatalogueCache(
          key,
          data,
          this.environment.ONSWITCH_CATALOGUE_TTL_SECONDS,
        )
        return { data, asOf: stored.fetchedAt.toISOString(), stale: false }
      } catch {
        if (previous) {
          const parsed = schema.safeParse(previous.payload)
          if (parsed.success)
            return { data: parsed.data, asOf: previous.fetchedAt.toISOString(), stale: true }
        }
        throw new AppError(
          'PAYMENT_CATALOGUE_UNAVAILABLE',
          'Payment options are temporarily unavailable',
          503,
        )
      } finally {
        this.inFlight.delete(key)
      }
    })()
    this.inFlight.set(key, task)
    return await task
  }
}

const normalizedCoverageSchema = z.object({
  country: z.string(),
  currencies: z.array(z.string()),
  channels: z.array(channelSchema),
  directions: z.array(directionSchema),
  settlementTimes: z.record(z.string(), z.string()),
  payoutLimits: z.record(
    z.string(),
    z.union([z.object({ min: z.string().optional(), max: z.string().optional() }), z.string()]),
  ),
  note: z.string().optional(),
})

function normalizeCoverage(row: z.infer<typeof coverageSchema>[number]): NormalizedCoverage {
  const payoutLimits: NormalizedCoverage['payoutLimits'] = {}
  const settlementTimes: Record<string, string> = {}
  for (const channel of row.channel) {
    const settlement = boundedString(row.settlement_time?.[channel], 160)
    if (settlement) settlementTimes[channel] = settlement
    const value = row.payout_limit?.[channel]
    if (value === undefined) continue
    if (typeof value === 'string') {
      payoutLimits[channel] = value.slice(0, 160)
      continue
    }
    if (typeof value !== 'object' || value === null) continue
    const band = value as { min?: unknown; max?: unknown }
    const min = scalarString(band.min)
    const max = scalarString(band.max)
    payoutLimits[channel] = {
      ...(min ? { min } : {}),
      ...(max ? { max } : {}),
    }
  }
  const note = boundedString(row.payout_limit?.note, 160)
  return {
    country: row.country,
    currencies: row.currency,
    channels: row.channel,
    directions: row.direction,
    settlementTimes,
    payoutLimits,
    ...(note ? { note } : {}),
  }
}

type ProviderAsset = z.infer<typeof providerAssetSchema>[number]

function mapTrustedAsset(provider: ProviderAsset, verifiedNetworks: ReadonlySet<string>) {
  const network = networkFromProviderName(provider.blockchain.name)
  if (!network || !verifiedNetworks.has(network.networkId)) return null
  const token = BALANCE_TOKENS[network.networkId]?.find(
    (candidate) =>
      candidate.symbol.toUpperCase() === provider.code.toUpperCase() &&
      candidate.decimals === provider.decimals &&
      sameAddress(network.family, candidate.address, provider.address),
  )
  if (!token) return null
  return {
    assetKey: `${network.networkId}:${token.symbol.toLowerCase()}`,
    networkId: network.networkId,
    symbol: token.symbol,
    decimals: token.decimals,
    address: token.address,
    providerOnramp: provider.onramp_supported,
    providerOfframp: provider.offramp_supported,
  }
}

function networkFromProviderName(name: string) {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '')
  const aliases: Record<string, string> = {
    ethereum: 'ethereum-mainnet',
    ethereummainnet: 'ethereum-mainnet',
    eth: 'ethereum-mainnet',
    arbitrum: 'arbitrum-one',
    arbitrumone: 'arbitrum-one',
    arbitrummainnet: 'arbitrum-one',
    solana: 'solana-mainnet-beta',
    solanamainnet: 'solana-mainnet-beta',
    solanamainnetbeta: 'solana-mainnet-beta',
  }
  const id = aliases[normalized]
  return id ? (NETWORKS.find((network) => network.networkId === id) ?? null) : null
}

function sameAddress(family: string, left: string, right: string): boolean {
  return family === 'evm' ? left.toLowerCase() === right.toLowerCase() : left === right
}

function parseProviderData<T>(response: OnSwitchEnvelope, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T {
  const parsed = schema.safeParse(response.data)
  if (!parsed.success)
    throw new AppError(
      'PAYMENT_PROVIDER_INVALID_RESPONSE',
      'Payment provider returned invalid catalogue data',
      502,
    )
  return parsed.data
}

function parseProviderObject(response: OnSwitchEnvelope): Record<string, unknown> {
  if (typeof response.data !== 'object' || response.data === null || Array.isArray(response.data))
    throw new AppError(
      'PAYMENT_PROVIDER_INVALID_RESPONSE',
      'Payment provider returned an invalid lookup result',
      502,
    )
  return response.data as Record<string, unknown>
}

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const safe = stripControlCharacters(value).trim().slice(0, maxLength)
  return safe || null
}

function stripControlCharacters(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0)
      return code >= 32 && code !== 127
    })
    .join('')
}

function scalarString(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const safe = String(value).trim().slice(0, 64)
  return safe || undefined
}

function minIso(...values: string[]): string {
  return values
    .map((value) => new Date(value))
    .sort((left, right) => left.getTime() - right.getTime())[0]!
    .toISOString()
}

function normalizeRequirements(fields: z.infer<typeof providerRequirementSchema>) {
  return fields.map((field) => {
    const normalized = {
      ...field,
      regex: normalizeProviderRequirementPattern(field),
      required: field.required ?? true,
      example: stripControlCharacters(field.example).slice(0, 128),
      ...(field.hint ? { hint: stripControlCharacters(field.hint).slice(0, 256) } : {}),
      ...(field.option
        ? {
            option: field.option.map((option) => ({
              name: stripControlCharacters(option.name).slice(0, 160),
              code: stripControlCharacters(option.code).slice(0, 128),
            })),
          }
        : {}),
    }
    const parsed = requirementSchema.element.safeParse(normalized)
    if (!parsed.success)
      throw new AppError(
        'PAYMENT_PROVIDER_INVALID_RESPONSE',
        'Payment provider returned invalid catalogue data',
        502,
      )
    return parsed.data
  })
}

function normalizeProviderRequirementPattern(
  field: z.infer<typeof providerRequirementSchema>[number],
): string {
  const path = field.path.replace(/^beneficiary\./, '')

  // Switch currently returns an ungrouped alternation for this field. Replace
  // it with a fully anchored rule derived only from the supported option codes.
  if (path === 'holder_type') {
    const optionCodes = field.option?.map((option) => option.code) ?? ['INDIVIDUAL', 'BUSINESS']
    const supportedCodes = (['INDIVIDUAL', 'BUSINESS'] as const).filter((code) => optionCodes.includes(code))
    if (supportedCodes.length === 0) return field.regex
    if (supportedCodes.length === 1) return `^${supportedCodes[0]}$`
    return `^(?:${[...new Set(supportedCodes)].join('|')})$`
  }

  // This equivalent bounded rule avoids forwarding Switch's look-ahead regex
  // while retaining its current name constraints (length, allowed characters,
  // and at least one ASCII letter).
  if (path === 'holder_name') return "^(?=.*[A-Za-z])[A-Za-z0-9\\s'&().,;-]{2,100}$"

  return field.regex
}

function isSafeProviderPattern(value: string): boolean {
  if (
    value === '^(?:INDIVIDUAL|BUSINESS)$' ||
    value === '^(?=.*[A-Za-z])[A-Za-z0-9\\s\'&().,;-]{2,100}$'
  )
    return true

  // The provider supplies these patterns. Accept only anchored, simple
  // character classes/escapes and at most one bounded-or-linear quantifier;
  // reject groups, alternation, backreferences, and nested quantifiers to
  // prevent a malicious or erroneous catalogue value from causing ReDoS in a
  // browser form.
  if (value.length > 256 || !value.startsWith('^') || !value.endsWith('$')) return false
  if (
    !/^\^(?:\\[dDsSwW]|[A-Za-z0-9 ._/-]|\[[A-Za-z0-9 _-]+\])+(?:\?|\*|\+|\{\d{1,3}(?:,\d{0,3})?\})?\$$/.test(
      value,
    )
  )
    return false
  try {
    new RegExp(value)
    return true
  } catch {
    return false
  }
}
