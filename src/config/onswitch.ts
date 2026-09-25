import type { Environment } from './env.js'

export const ONSWITCH_API_ORIGIN = 'https://api.onswitch.xyz'

export type OnSwitchRuntimeConfig = {
  environment: 'sandbox' | 'live'
  serviceKey: string
  timeoutMs: number
}

/**
 * Returns no client configuration while the integration is disabled. When
 * enabled, select exactly the secret for the configured environment. The
 * API origin is intentionally not environment-configurable: the provider
 * uses one HTTPS host for sandbox and live requests.
 */
export function getOnSwitchRuntimeConfig(environment: Environment): OnSwitchRuntimeConfig | null {
  if (!environment.ONSWITCH_ENABLED) return null

  const serviceKey =
    environment.ONSWITCH_ENVIRONMENT === 'sandbox'
      ? environment.ONSWITCH_SANDBOX_SERVICE_KEY
      : environment.ONSWITCH_LIVE_SERVICE_KEY
  if (!serviceKey) {
    // Environment validation normally catches this first. Keep the runtime
    // boundary defensive for callers constructing Environment in tests/tools.
    throw new Error(`OnSwitch ${environment.ONSWITCH_ENVIRONMENT} mode is enabled without its service key`)
  }

  return {
    environment: environment.ONSWITCH_ENVIRONMENT,
    serviceKey,
    timeoutMs: environment.ONSWITCH_TIMEOUT_MS,
  }
}
