import { z } from 'zod'

const booleanFromEnvironment = z.enum(['true', 'false']).transform((value) => value === 'true')
const providerServiceKey = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[\x21-\x7e]+$/)
  .optional()

// Whitespace is never meaningful in a URL, and stray spaces are easy to
// introduce when hand-editing a .env. Trim before validating so the failure is
// about a genuinely wrong value rather than an invisible character.
const optionalUrl = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim() : value),
  z.string().url().optional(),
)

const commaSeparatedOrigins = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().url()).min(1))

export const EnvironmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3030),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
    LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'debug']).default('info'),
    CORS_ALLOWED_ORIGINS: commaSeparatedOrigins.default('http://localhost:3000,http://localhost:3001'),
    JSON_BODY_LIMIT: z
      .string()
      .regex(/^\d+(b|kb|mb)$/i)
      .default('256kb'),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
    AUTH_BYPASS_ENABLED: booleanFromEnvironment.default('false'),
    AUTH_ACCESS_TOKEN_SECRET: z.string().min(32).default('development-access-token-secret-change-me'),
    AUTH_ACCESS_TOKEN_PREVIOUS_SECRET: z.string().min(32).optional(),
    AUTH_ACCESS_TOKEN_KID: z.string().min(1).max(64).default('primary'),
    AUTH_ACCESS_TOKEN_PREVIOUS_KID: z.string().min(1).max(64).optional(),
    AUTH_TOKEN_ISSUER: z.string().min(1).default('tsionmarket-backend'),
    AUTH_TOKEN_AUDIENCE: z.string().min(1).default('tsionmarket-client'),
    AUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    AUTH_REFRESH_TOKEN_PEPPER: z.string().min(32).default('development-refresh-token-pepper-change-me'),
    AUTH_PASSWORD_PEPPER: z.string().min(32).default('development-password-pepper-change-me'),
    AUTH_CHALLENGE_PEPPER: z.string().min(32).default('development-challenge-pepper-change-me'),
    AUTH_REFRESH_IDLE_TTL_SECONDS: z.coerce.number().int().min(3600).default(2_592_000),
    AUTH_REFRESH_ABSOLUTE_TTL_SECONDS: z.coerce.number().int().min(3600).default(7_776_000),
    AUTH_VERIFICATION_TTL_SECONDS: z.coerce.number().int().min(300).default(3600),
    AUTH_RESET_TTL_SECONDS: z.coerce.number().int().min(300).default(1800),
    AUTH_MAX_LOGIN_FAILURES: z.coerce.number().int().min(3).max(20).default(5),
    AUTH_LOCKOUT_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
    AUTH_CLEANUP_INTERVAL_SECONDS: z.coerce.number().int().min(60).default(3600),
    AUTH_TERMS_VERSION: z.string().min(1).max(50).default('2026-09-22'),
    AUTH_COOKIE_NAME: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .default('tsion_refresh'),
    AUTH_CSRF_COOKIE_NAME: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .default('tsion_csrf'),
    AUTH_COOKIE_DOMAIN: z.string().min(1).optional(),
    AUTH_EMAIL_DELIVERY_MODE: z.enum(['console', 'http', 'smtp']).default('console'),
    AUTH_EMAIL_PROVIDER_URL: optionalUrl,
    AUTH_EMAIL_PROVIDER_API_KEY: z.string().min(1).optional(),
    AUTH_SMTP_HOST: z.string().min(1).optional(),
    AUTH_SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(465),
    // Port 465 is implicit TLS. Port 587 is STARTTLS and needs this false.
    AUTH_SMTP_SECURE: booleanFromEnvironment.default('true'),
    AUTH_SMTP_USER: z.string().min(1).optional(),
    AUTH_SMTP_PASSWORD: z.string().min(1).optional(),
    // Envelope sender, e.g. "TsionMarket <no-reply@tsionmarket.com>".
    AUTH_EMAIL_FROM: z.string().min(1).optional(),
    // Base URL for the verification and reset links placed in email bodies.
    AUTH_EMAIL_LINK_BASE_URL: optionalUrl,
    NETWORK_MODE: z.enum(['development', 'testnet', 'mainnet']).default('development'),
    ETHEREUM_SEPOLIA_RPC_URL: z.string().optional(),
    ETHEREUM_SEPOLIA_FALLBACK_RPC_URL: z.string().optional(),
    ARBITRUM_SEPOLIA_RPC_URL: z.string().optional(),
    ARBITRUM_SEPOLIA_FALLBACK_RPC_URL: z.string().optional(),
    SOLANA_RPC_URL: z.string().optional(),
    SOLANA_FALLBACK_RPC_URL: z.string().optional(),
    ETHEREUM_RPC_URLS: z.string().optional(),
    ETHEREUM_RPC_URL: z.string().optional(),
    ETHEREUM_FALLBACK_RPC_URL: z.string().optional(),
    ARBITRUM_RPC_URLS: z.string().optional(),
    ARBITRUM_RPC_URL: z.string().optional(),
    ARBITRUM_FALLBACK_RPC_URL: z.string().optional(),
    SOLANA_MAINNET_RPC_URLS: z.string().optional(),
    SOLANA_MAINNET_RPC_URL: z.string().optional(),
    INTERTRAIN_MAINNET_RPC_URLS: z.string().optional(),
    INTERTRAIN_MAINNET_RPC_URL: z.string().optional(),
    RPC_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(8_000),
    RPC_MAX_RETRIES: z.coerce.number().int().min(0).max(3).default(1),
    RPC_PROVIDER_COOLDOWN_MS: z.coerce.number().int().min(1000).default(30_000),
    BALANCE_CACHE_TTL_MS: z.coerce.number().int().min(1000).default(15_000),
    BALANCE_AGGREGATE_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(12_000),
    BALANCE_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(5),
    SPOT_MARKET_REGISTRY_ENABLED: booleanFromEnvironment.default('false'),
    SPOT_MARKET_REGISTRY_START_DELAY_SECONDS: z.coerce.number().int().min(0).default(15),
    SPOT_MARKET_REGISTRY_INTERVAL_SECONDS: z.coerce.number().int().min(60).default(900),
    SPOT_MARKET_REGISTRY_MAX_TOKENS_PER_ROUTE: z.coerce.number().int().min(1).max(5000).default(500),
    MARKET_STALE_AFTER_SECONDS: z.coerce.number().int().min(60).default(1800),
    JUPITER_API_KEY: z.string().optional(),
    // Chart sources. Both optional: without a key the chart falls through to
    // the next source rather than failing, so an unkeyed deployment still
    // draws pool candles from GeckoTerminal, which needs none.
    BIRDEYE_API_KEY: z.string().optional(),
    // The house address players send USDC to. Read-only here: crediting a
    // balance needs no key, only a confirmed transfer.
    ARCADE_DEPOSIT_ADDRESS: z.string().min(32).max(64).optional(),
    // 0.1% to 1%, per the product decision. Capped in schema so a fat finger
    // cannot set 50%.
    ARCADE_DEPOSIT_FEE_BPS: z.coerce.number().int().min(0).max(100).default(10),
    ARCADE_DEPOSIT_SCAN_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(600).default(20),
    COINGECKO_API_KEY: z.string().optional(),
    LIFI_API_URL: z.string().url().default('https://li.quest/v1'),
    LIFI_API_KEY: z.string().optional(),
    LIFI_INTEGRATOR: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .default('tewa'),
    LIFI_QUOTE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30_000).default(15_000),
    // OnSwitch uses the same API origin for sandbox and live credentials.
    // Keep the two secrets separate and select them only on the server.
    ONSWITCH_ENABLED: booleanFromEnvironment.default('false'),
    ONSWITCH_ENVIRONMENT: z.enum(['sandbox', 'live']).default('sandbox'),
    ONSWITCH_ONRAMP_STARTS_ENABLED: booleanFromEnvironment.default('true'),
    ONSWITCH_OFFRAMP_STARTS_ENABLED: booleanFromEnvironment.default('true'),
    ONSWITCH_SANDBOX_SERVICE_KEY: providerServiceKey,
    ONSWITCH_LIVE_SERVICE_KEY: providerServiceKey,
    ONSWITCH_DATA_ENCRYPTION_KEY: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .optional(),
    ONSWITCH_IDEMPOTENCY_SECRET: z
      .string()
      .min(32)
      .max(4096)
      .regex(/^[\x21-\x7e]+$/)
      .optional(),
    ONSWITCH_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30_000).default(10_000),
    ONSWITCH_CATALOGUE_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
    ONSWITCH_WORKER_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(600).default(20),
    ONSWITCH_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
    ONSWITCH_WORKER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(12),
    ONSWITCH_WORKER_LOCK_SECONDS: z.coerce.number().int().min(10).max(600).default(90),
    ONSWITCH_MAX_ACTIVE_OPERATIONS_PER_USER: z.coerce.number().int().min(1).max(20).default(5),
    SWAP_QUOTE_TTL_SECONDS: z.coerce.number().int().min(15).max(300).default(60),
    TRANSACTION_INTENT_TTL_SECONDS: z.coerce.number().int().min(30).max(1800).default(300),
    MAX_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(5000).default(500),
    FEE_SAFETY_BUFFER_BPS: z.coerce.number().int().min(0).max(10_000).default(2000),
    SUBMISSION_MAX_BYTES: z.coerce.number().int().min(1024).max(1_000_000).default(200_000),
    TRANSACTION_RECONCILE_INTERVAL_SECONDS: z.coerce.number().int().min(5).default(30),
    TRANSACTION_RECONCILE_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
    TRANSACTION_RECONCILE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(20),
    METRICS_ENABLED: booleanFromEnvironment.default('true'),
    METRICS_BEARER_TOKEN: z.string().min(32).optional(),
    MYSQL_HOST: z.string().min(1),
    MYSQL_PORT: z.coerce.number().int().min(1).max(65_535).default(3306),
    MYSQL_DATABASE: z.string().regex(/^[a-zA-Z0-9_]+$/),
    MYSQL_USER: z.string().min(1),
    MYSQL_PASSWORD: z.string().min(1),
    MYSQL_CONNECTION_LIMIT: z.coerce.number().int().min(1).max(100).default(10),
    MYSQL_QUEUE_LIMIT: z.coerce.number().int().min(1).max(10_000).default(100),
    MYSQL_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    MYSQL_ACQUIRE_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    MYSQL_QUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    MYSQL_MIGRATION_USER: z.string().min(1),
    MYSQL_MIGRATION_PASSWORD: z.string().min(1),
    MYSQL_MIGRATION_LOCK_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(300).default(30),
  })
  .superRefine((value, context) => {
    if (value.ONSWITCH_ENABLED) {
      const activeKey =
        value.ONSWITCH_ENVIRONMENT === 'sandbox'
          ? value.ONSWITCH_SANDBOX_SERVICE_KEY
          : value.ONSWITCH_LIVE_SERVICE_KEY
      const activeKeyPath =
        value.ONSWITCH_ENVIRONMENT === 'sandbox'
          ? 'ONSWITCH_SANDBOX_SERVICE_KEY'
          : 'ONSWITCH_LIVE_SERVICE_KEY'
      if (!activeKey) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [activeKeyPath],
          message: `OnSwitch ${value.ONSWITCH_ENVIRONMENT} mode requires its server-side service key`,
        })
      }
      if (!value.ONSWITCH_IDEMPOTENCY_SECRET) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ONSWITCH_IDEMPOTENCY_SECRET'],
          message: 'OnSwitch requires a dedicated server-side idempotency secret',
        })
      }
      if (!value.ONSWITCH_DATA_ENCRYPTION_KEY) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ONSWITCH_DATA_ENCRYPTION_KEY'],
          message: 'OnSwitch requires a dedicated 32-byte payment-instructions encryption key',
        })
      }
      if (value.ONSWITCH_ENVIRONMENT === 'live' && value.NODE_ENV !== 'production') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ONSWITCH_ENVIRONMENT'],
          message: 'OnSwitch live mode is allowed only in production',
        })
      }
    }
    if (Boolean(value.AUTH_ACCESS_TOKEN_PREVIOUS_SECRET) !== Boolean(value.AUTH_ACCESS_TOKEN_PREVIOUS_KID)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_ACCESS_TOKEN_PREVIOUS_SECRET'],
        message: 'Previous access-token secret and key ID must be configured together',
      })
    }
    if (value.AUTH_REFRESH_ABSOLUTE_TTL_SECONDS < value.AUTH_REFRESH_IDLE_TTL_SECONDS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_REFRESH_ABSOLUTE_TTL_SECONDS'],
        message: 'Absolute refresh lifetime must be at least the idle refresh lifetime',
      })
    }
    if (value.AUTH_BYPASS_ENABLED && !['development', 'test'].includes(value.NODE_ENV)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_BYPASS_ENABLED'],
        message: 'Authentication bypass is allowed only in development or test',
      })
    }
    if (['staging', 'production'].includes(value.NODE_ENV)) {
      const developmentSecrets = [
        value.AUTH_ACCESS_TOKEN_SECRET,
        value.AUTH_REFRESH_TOKEN_PEPPER,
        value.AUTH_PASSWORD_PEPPER,
        value.AUTH_CHALLENGE_PEPPER,
      ].some((secret) => secret.startsWith('development-'))
      if (developmentSecrets) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['AUTH_ACCESS_TOKEN_SECRET'],
          message: 'Development authentication secrets are forbidden outside local/test',
        })
      }
      // Real delivery is mandatory outside local/test: either an HTTP provider
      // or SMTP, each fully configured. Console delivery drops mail silently.
      if (value.AUTH_EMAIL_DELIVERY_MODE === 'http') {
        if (!value.AUTH_EMAIL_PROVIDER_URL || !value.AUTH_EMAIL_PROVIDER_API_KEY) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['AUTH_EMAIL_PROVIDER_URL'],
            message: 'HTTP email delivery requires provider URL and API key outside local/test',
          })
        }
      } else if (value.AUTH_EMAIL_DELIVERY_MODE === 'smtp') {
        const missing = (
          [
            ['AUTH_SMTP_HOST', value.AUTH_SMTP_HOST],
            ['AUTH_SMTP_USER', value.AUTH_SMTP_USER],
            ['AUTH_SMTP_PASSWORD', value.AUTH_SMTP_PASSWORD],
            ['AUTH_EMAIL_FROM', value.AUTH_EMAIL_FROM],
            ['AUTH_EMAIL_LINK_BASE_URL', value.AUTH_EMAIL_LINK_BASE_URL],
          ] as const
        ).filter(([, setting]) => !setting)
        for (const [path] of missing) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [path],
            message: 'SMTP email delivery requires this value outside local/test',
          })
        }
      } else {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['AUTH_EMAIL_DELIVERY_MODE'],
          message: 'Email delivery must be "http" or "smtp" outside local/test',
        })
      }
      if (value.MYSQL_PASSWORD.length < 16) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MYSQL_PASSWORD'],
          message: 'Application database password must be at least 16 characters outside local/test',
        })
      }
      if (value.MYSQL_MIGRATION_PASSWORD.length < 16) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MYSQL_MIGRATION_PASSWORD'],
          message: 'Migration database password must be at least 16 characters outside local/test',
        })
      }
      if (value.MYSQL_USER === value.MYSQL_MIGRATION_USER) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MYSQL_MIGRATION_USER'],
          message: 'Application and migration database users must differ outside local/test',
        })
      }
      if (!value.METRICS_BEARER_TOKEN) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['METRICS_BEARER_TOKEN'],
          message: 'Metrics bearer token is required outside local/test',
        })
      }
    }
  })

export type Environment = z.infer<typeof EnvironmentSchema>

/**
 * Normalises raw environment input before validation:
 *
 * - Strips trailing CR/LF. A `.env` saved with Windows line endings yields
 *   values like `https://example.com\r`, which fail URL validation with a
 *   message that points nowhere useful.
 * - Treats an empty value as unset. Compose substitutes unused optionals as
 *   empty strings (`${FOO:-}`), and `''` is not `undefined`, so optional URL
 *   and non-empty-string fields would reject it instead of falling back.
 *
 * Interior and leading whitespace is preserved — it can be meaningful in a
 * password.
 */
function normaliseEnvironment(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== 'string') continue
    const cleaned = value.replace(/[\r\n]+$/, '')
    if (cleaned !== '') output[key] = cleaned
  }
  return output
}

export function parseEnvironment(input: NodeJS.ProcessEnv): Environment {
  const parsed = EnvironmentSchema.safeParse(normaliseEnvironment(input))
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`)
      .join('; ')
    throw new Error(`Environment validation failed: ${details}`)
  }
  return parsed.data
}

let cachedEnvironment: Environment | undefined

export function getEnvironment(): Environment {
  cachedEnvironment ??= parseEnvironment(process.env)
  return cachedEnvironment
}

export function resetEnvironmentForTests(): void {
  cachedEnvironment = undefined
}
