import { describe, expect, it } from 'vitest'
import {
  ChainAdapterRegistry,
  SessionAuthorityRegistry,
  SponsorshipRegistry,
} from '../src/extensions/registries.js'

describe('post-launch extension gates', () => {
  it('fails closed for missing chain adapters', () => {
    expect(() => new ChainAdapterRegistry().require('sui')).toThrowError(
      'No chain adapter is configured for sui',
    )
  })
  it('refuses unaudited session authority', () => {
    expect(() =>
      new SessionAuthorityRegistry().register({ family: 'evm', audited: false, auditReference: '' }),
    ).toThrowError('unaudited')
  })
  it('refuses unaudited sponsorship and reports disabled by default', () => {
    const registry = new SponsorshipRegistry()
    expect(registry.config()).toMatchObject({ enabled: false })
    expect(() => registry.register({ id: 'fake', audited: false, auditReference: '' })).toThrowError(
      'unaudited',
    )
  })
})
