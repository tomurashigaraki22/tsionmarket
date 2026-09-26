import { describe, expect, it, vi } from 'vitest'
import { parseEnvironment } from '../src/config/env.js'
import type { OnSwitchEnvelope } from '../src/payments/onswitch/client.js'
import { OnSwitchCatalogueService, type OnSwitchCatalogueClient } from '../src/payments/onswitch/catalogue.js'
import type {
  CachedCatalogue,
  OnSwitchPaymentRepository,
  ProviderBeneficiaryReference,
} from '../src/payments/onswitch/repository.js'

const ENV = parseEnvironment({
  NODE_ENV: 'test',
  MYSQL_HOST: 'localhost',
  MYSQL_DATABASE: 'payments_test',
  MYSQL_USER: 'app',
  MYSQL_PASSWORD: 'password',
  MYSQL_MIGRATION_USER: 'migration',
  MYSQL_MIGRATION_PASSWORD: 'password',
  NETWORK_MODE: 'mainnet',
  ONSWITCH_ENABLED: 'true',
  ONSWITCH_ENVIRONMENT: 'sandbox',
  ONSWITCH_SANDBOX_SERVICE_KEY: 'sandbox-secret-not-real',
  ONSWITCH_DATA_ENCRYPTION_KEY: 'e'.repeat(64),
  ONSWITCH_IDEMPOTENCY_SECRET: 'idempotency-secret-with-at-least-32-chars',
  ONSWITCH_CATALOGUE_TTL_SECONDS: '60',
})

const verifiedRef: ProviderBeneficiaryReference = {
  id: 'bdc47a03-daa4-4d81-a975-629c8a58a9de',
  providerBeneficiaryId: '69e8e664b9fea9f9e6dc3cbb',
  country: 'NG',
  fiatCurrency: 'NGN',
  channel: 'BANK',
  holderType: 'INDIVIDUAL',
  maskedLabel: 'Main bank •••• 5678',
  createdAt: new Date('2026-09-25T10:00:00.000Z'),
}

function envelope(data: unknown): OnSwitchEnvelope {
  return { success: true, data }
}

function makeRepository(options?: {
  networks?: string[]
  beneficiaries?: ProviderBeneficiaryReference[]
  now?: () => Date
}) {
  const cache = new Map<string, CachedCatalogue>()
  const verifiedEnabledNetworks = vi.fn(async () => options?.networks ?? ['arbitrum-one'])
  const listBeneficiaryReferences = vi.fn(async () => options?.beneficiaries ?? [])
  const repository = {
    async getCatalogueCache(key: string) {
      return cache.get(key) ?? null
    },
    async setCatalogueCache(key: string, payload: unknown, ttlSeconds: number) {
      const fetchedAt = options?.now?.() ?? new Date()
      const row = { payload, fetchedAt, expiresAt: new Date(fetchedAt.getTime() + ttlSeconds * 1000) }
      cache.set(key, row)
      return row
    },
    verifiedEnabledNetworks,
    listBeneficiaryReferences,
  } satisfies Pick<
    OnSwitchPaymentRepository,
    'getCatalogueCache' | 'setCatalogueCache' | 'verifiedEnabledNetworks' | 'listBeneficiaryReferences'
  >
  return { repository, cache, verifiedEnabledNetworks, listBeneficiaryReferences }
}

function coverage(direction: 'ONRAMP' | 'OFFRAMP') {
  return [
    {
      country: 'NG',
      currency: ['NGN'],
      continent: 'AFRICA',
      default_channel: 'BANK',
      channel: ['BANK'],
      direction: [direction],
      settlement_time: { BANK: 'Within one business day' },
      payout_limit: { BANK: { min: '1000', max: '5000000' }, note: 'Per transaction' },
    },
  ]
}

const canonicalArbitrumUsdc = {
  id: 'arbitrum:usdc',
  name: 'USD Coin',
  code: 'USDC',
  decimals: 6,
  address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
  blockchain: { id: 42161, name: 'Arbitrum One' },
  onramp_supported: true,
  offramp_supported: true,
  swap_supported: true,
  wallet_supported: true,
}

describe('OnSwitch dynamic catalogue', () => {
  it('intersects provider coverage/assets with enabled verified accounts and the canonical token registry', async () => {
    const { repository, verifiedEnabledNetworks } = makeRepository({ networks: ['arbitrum-one'] })
    const client: OnSwitchCatalogueClient = {
      get: vi.fn(async (path, query) => {
        if (path === '/coverage') {
          const direction = query?.direction as 'ONRAMP' | 'OFFRAMP'
          return envelope(coverage(direction))
        }
        if (path === '/asset')
          return envelope([
            canonicalArbitrumUsdc,
            {
              ...canonicalArbitrumUsdc,
              id: 'arbitrum:fake',
              address: '0x1111111111111111111111111111111111111111',
            },
            { ...canonicalArbitrumUsdc, id: 'arbitrum:usdt', code: 'USDT' },
            {
              ...canonicalArbitrumUsdc,
              id: 'solana:usdc',
              address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
              blockchain: { id: 101, name: 'Solana' },
            },
          ])
        throw new Error('Unexpected catalogue endpoint')
      }),
      post: vi.fn(async () => envelope({})),
    }
    const service = new OnSwitchCatalogueService(client, repository, ENV)

    const result = await service.capabilities('user-a')

    expect(verifiedEnabledNetworks).toHaveBeenCalledWith('user-a')
    expect(result.enabled).toBe(true)
    expect(result.stale).toBe(false)
    expect(result.coverage.onramp[0]).toMatchObject({
      country: 'NG',
      currencies: ['NGN'],
      payoutLimits: { BANK: { min: '1000', max: '5000000' } },
    })
    expect(result.assets).toEqual([
      {
        assetKey: 'arbitrum-one:usdc',
        networkId: 'arbitrum-one',
        symbol: 'USDC',
        decimals: 6,
        address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
        providerOnramp: true,
        providerOfframp: true,
        onrampAvailable: true,
        offrampAvailable: true,
      },
    ])
  })

  it('serves stale catalogue with an explicit stale flag but blocks use for new operations', async () => {
    let now = new Date('2026-09-25T10:00:00.000Z')
    const { repository } = makeRepository({ networks: ['arbitrum-one'], now: () => now })
    const client: OnSwitchCatalogueClient = {
      get: vi.fn(async (path, query) => {
        if (path === '/coverage') return envelope(coverage(query?.direction as 'ONRAMP' | 'OFFRAMP'))
        if (path === '/asset') return envelope([canonicalArbitrumUsdc])
        throw new Error('Unexpected catalogue endpoint')
      }),
      post: vi.fn(async () => envelope({})),
    }
    const service = new OnSwitchCatalogueService(client, repository, ENV, () => now)
    await service.capabilities('user-a')
    now = new Date(now.getTime() + 61_000)
    vi.mocked(client.get).mockRejectedValue(new Error('provider unavailable'))

    const stale = await service.capabilities('user-a')
    expect(stale.stale).toBe(true)
    await expect(
      service.requireAvailableSelection({
        userId: 'user-a',
        operationType: 'offramp',
        country: 'NG',
        currency: 'NGN',
        channel: 'BANK',
        assetKey: 'arbitrum-one:usdc',
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_CATALOGUE_STALE', statusCode: 503 })
  })

  it('validates provider beneficiary regexes before returning or caching requirements', async () => {
    const { repository } = makeRepository()
    const client: OnSwitchCatalogueClient = {
      get: vi.fn(async () =>
        envelope([
          { path: 'beneficiary.account_number', regex: '^\\d{10}$', example: '0123456789', required: true },
        ]),
      ),
      post: vi.fn(async () => envelope({})),
    }
    const service = new OnSwitchCatalogueService(client, repository, ENV)
    const result = await service.requirements({
      direction: 'OFFRAMP',
      country: 'NG',
      currency: 'NGN',
      channel: 'BANK',
    })
    expect(result.data[0]?.regex).toBe('^\\d{10}$')

    vi.mocked(client.get).mockResolvedValue(
      envelope([{ path: 'account', regex: '^(a+)+$', example: 'x', required: true }]),
    )
    const unsafeService = new OnSwitchCatalogueService(client, makeRepository().repository, ENV)
    await expect(unsafeService.requirements({ direction: 'OFFRAMP', country: 'NG' })).rejects.toMatchObject({
      code: 'PAYMENT_CATALOGUE_UNAVAILABLE',
      statusCode: 503,
    })
  })

  it('normalizes Switch bank requirements with optional required flags and metadata', async () => {
    const { repository } = makeRepository()
    const client: OnSwitchCatalogueClient = {
      get: vi.fn(async () =>
        envelope([
          {
            path: 'holder_type',
            regex: '^INDIVIDUAL|BUSINESS$',
            example: 'INDIVIDUAL',
            hint: 'Select a holder type from the options',
            option: [
              { name: 'Individual', code: 'INDIVIDUAL' },
              { name: 'Business', code: 'BUSINESS' },
            ],
          },
          {
            path: 'holder_name',
            regex: "^(?=.*[A-Za-z])[A-Za-z0-9\\s\\-'&().,;]{2,100}$",
            example: 'John Doe',
            hint: 'Must be a valid 2-100 characters long name',
            option: [],
          },
          {
            path: 'channel',
            regex: '^BANK$',
            example: 'BANK',
            hint: 'Select a transfer channel from the options',
            option: [{ name: 'Bank', code: 'BANK' }],
          },
          {
            path: 'wallet_address',
            regex: '^[0-9A-Za-z]{20,100}$',
            example: '0x1234567890123456789012345678901234567890',
            hint: 'Must be a valid Solana or any EVM wallet address',
            option: [],
          },
        ]),
      ),
      post: vi.fn(async () => envelope({})),
    }
    const service = new OnSwitchCatalogueService(client, repository, ENV)

    const result = await service.requirements({
      direction: 'ONRAMP',
      country: 'NG',
      currency: 'NGN',
      channel: 'BANK',
      holderType: 'INDIVIDUAL',
    })

    expect(result.data).toHaveLength(4)
    expect(result.data[0]).toMatchObject({
      path: 'holder_type',
      regex: '^(?:INDIVIDUAL|BUSINESS)$',
      required: true,
      option: [
        { name: 'Individual', code: 'INDIVIDUAL' },
        { name: 'Business', code: 'BUSINESS' },
      ],
    })
    expect(result.data[1]).toMatchObject({ path: 'holder_name', required: true })
    expect(new RegExp(result.data[1]!.regex).test("John O'Neil")).toBe(true)
    expect(result.data[2]).toMatchObject({ path: 'channel', required: true })
    expect(result.data[3]).toMatchObject({ path: 'wallet_address', required: true })
  })

  it('fills the requested country when Switch institution rows omit it', async () => {
    const { repository } = makeRepository()
    const get = vi.fn(async (path) => {
      if (path === '/institution')
        return envelope([
          { code: '000013', name: 'Guaranty Trust Bank' },
          { code: '100004', name: 'Opay' },
        ])
      throw new Error('Unexpected endpoint')
    })
    const client: OnSwitchCatalogueClient = { get, post: vi.fn(async () => envelope({})) }
    const service = new OnSwitchCatalogueService(client, repository, ENV)

    const result = await service.institutions({ country: 'NG', currency: 'NGN', channel: 'BANK' })

    expect(result.data).toEqual([
      { code: '000013', name: 'Guaranty Trust Bank', country: 'NG' },
      { code: '100004', name: 'Opay', country: 'NG' },
    ])
    expect(get).toHaveBeenCalledWith('/institution', {
      country: 'NG',
      currency: 'NGN',
      channel: 'BANK',
    })
  })

  it('returns institution lookup name with a masked account and never echoes full account data', async () => {
    const { repository } = makeRepository()
    const post = vi.fn(async () =>
      envelope({
        account_name: 'Ada Example',
        bank_code: '058',
        account_number: '1234567890',
        details: 'private',
      }),
    )
    const client: OnSwitchCatalogueClient = {
      get: vi.fn(async () => envelope([])),
      post,
    }
    const service = new OnSwitchCatalogueService(client, repository, ENV)
    const result = await service.lookupInstitution({
      country: 'NG',
      beneficiary: { account_number: '1234567890', bank_code: '058' },
    })
    expect(result).toEqual({
      accountName: 'Ada Example',
      bankCode: '058',
      accountNumberLastFour: '7890',
      matched: true,
    })
    expect(JSON.stringify(result)).not.toContain('1234567890')
    expect(post).toHaveBeenCalledWith('/institution/lookup', {
      country: 'NG',
      beneficiary: { account_number: '1234567890', bank_code: '058' },
    })
  })

  it('refreshes only the signed-in user’s locally associated beneficiary and returns no provider PII', async () => {
    const { repository, listBeneficiaryReferences } = makeRepository({ beneficiaries: [verifiedRef] })
    const get = vi.fn(async (path) => {
      if (path === '/beneficiary/fetch')
        return envelope({
          data: [
            {
              id: verifiedRef.providerBeneficiaryId,
              reference: 'provider-ref',
              name: 'Ada Example',
              category: 'INDIVIDUAL',
              channel: 'BANK',
              details: { account_number: '1234567890' },
            },
          ],
          page: 1,
          limit: 100,
          total: 1,
          pages: 1,
        })
      throw new Error('Unexpected endpoint')
    })
    const client: OnSwitchCatalogueClient = { get, post: vi.fn(async () => envelope({})) }
    const service = new OnSwitchCatalogueService(client, repository, ENV)

    const result = await service.refreshBeneficiary('user-a', verifiedRef.id)
    expect(result.data).toEqual({ exists: true })
    expect(JSON.stringify(result)).not.toContain('Ada Example')
    expect(JSON.stringify(result)).not.toContain('1234567890')
    expect(listBeneficiaryReferences).toHaveBeenCalledWith('user-a')
    expect(get).toHaveBeenCalledWith('/beneficiary/fetch', {
      search: verifiedRef.providerBeneficiaryId,
      page: 1,
      limit: 100,
    })
  })

  it('refuses beneficiary refresh for an ID not associated with the requesting user', async () => {
    const { repository } = makeRepository({ beneficiaries: [] })
    const client: OnSwitchCatalogueClient = {
      get: vi.fn(async () => envelope({ data: [], page: 1, limit: 100, total: 0, pages: 0 })),
      post: vi.fn(async () => envelope({})),
    }
    const service = new OnSwitchCatalogueService(client, repository, ENV)
    await expect(service.refreshBeneficiary('user-b', verifiedRef.id)).rejects.toMatchObject({
      code: 'PAYMENT_BENEFICIARY_NOT_FOUND',
      statusCode: 404,
    })
  })
})
