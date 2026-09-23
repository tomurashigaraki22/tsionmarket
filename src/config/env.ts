import { z } from 'zod'

const booleanFromEnvironment = z.enum(['true', 'false']).transform((value) => value === 'true')

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
    AUTH_EMAIL_DELIVERY_MODE: z.enum(['console', 'http']).default('console'),
    AUTH_EMAIL_PROVIDER_URL: z.string().url().optional(),
    AUTH_EMAIL_PROVIDER_API_KEY: z.string().min(1).optional(),
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
    LIFI_API_URL: z.string().url().default('https://li.quest/v1'),
    LIFI_API_KEY: z.string().optional(),
    LIFI_INTEGRATOR: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .default('tewa'),
    LIFI_QUOTE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30_000).default(15_000),
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
      if (
        value.AUTH_EMAIL_DELIVERY_MODE !== 'http' ||
        !value.AUTH_EMAIL_PROVIDER_URL ||
        !value.AUTH_EMAIL_PROVIDER_API_KEY
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['AUTH_EMAIL_DELIVERY_MODE'],
          message: 'HTTP email delivery with URL and API key is required outside local/test',
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

export function parseEnvironment(input: NodeJS.ProcessEnv): Environment {
  const parsed = EnvironmentSchema.safeParse(input)
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
