import { AppError } from '../utils/errors.js'

export interface ChainAdapter {
  readonly family: string
  readonly networks: readonly string[]
}
export class ChainAdapterRegistry {
  private adapters = new Map<string, ChainAdapter>()
  register(adapter: ChainAdapter) {
    if (this.adapters.has(adapter.family)) throw new Error(`Adapter already registered: ${adapter.family}`)
    this.adapters.set(adapter.family, adapter)
  }
  require(family: string) {
    const adapter = this.adapters.get(family)
    if (!adapter)
      throw new AppError('CHAIN_ADAPTER_NOT_CONFIGURED', `No chain adapter is configured for ${family}`, 503)
    return adapter
  }
  list() {
    return [...this.adapters.values()].map((adapter) => ({
      family: adapter.family,
      networks: adapter.networks,
    }))
  }
}
export interface SessionAuthority {
  readonly family: string
  readonly audited: boolean
  readonly auditReference: string
}
export class SessionAuthorityRegistry {
  private adapters = new Map<string, SessionAuthority>()
  register(adapter: SessionAuthority) {
    if (!adapter.audited || !adapter.auditReference.trim())
      throw new Error(`Refusing to register unaudited ${adapter.family} session authority`)
    this.adapters.set(adapter.family, adapter)
  }
  require(family: string) {
    const adapter = this.adapters.get(family)
    if (!adapter)
      throw new AppError(
        'SESSION_AUTHORITY_NOT_CONFIGURED',
        `No audited ${family} session authority is configured`,
        503,
      )
    return adapter
  }
}
export interface SponsorshipProvider {
  readonly id: string
  readonly audited: boolean
  readonly auditReference: string
}
export class SponsorshipRegistry {
  private provider?: SponsorshipProvider
  register(provider: SponsorshipProvider) {
    if (!provider.audited || !provider.auditReference.trim())
      throw new Error('Refusing to register an unaudited sponsorship provider')
    this.provider = provider
  }
  config() {
    return this.provider
      ? { enabled: true, provider: this.provider.id, auditReference: this.provider.auditReference }
      : { enabled: false, reason: 'No audited sponsorship provider is configured' }
  }
  require() {
    if (!this.provider)
      throw new AppError('SPONSORSHIP_NOT_CONFIGURED', 'No audited sponsorship provider is configured', 503)
    return this.provider
  }
}
export const chainAdapters = new ChainAdapterRegistry(),
  sessionAuthorities = new SessionAuthorityRegistry(),
  sponsorshipProviders = new SponsorshipRegistry()
chainAdapters.register({ family: 'evm', networks: ['ethereum-mainnet', 'arbitrum-one'] })
chainAdapters.register({ family: 'solana', networks: ['solana-mainnet-beta'] })
