import { describe, expect, it } from 'vitest'
import { canonicalHash } from '../src/trading/TradingRepository.js'

describe('intent payload hashing', () => {
  it('is stable across object key order but binds nested transaction fields', () => {
    expect(canonicalHash({ network: 'ethereum', payload: { to: '0x1', value: '1' } })).toBe(
      canonicalHash({ payload: { value: '1', to: '0x1' }, network: 'ethereum' }),
    )
    expect(canonicalHash({ network: 'ethereum', payload: { to: '0x1', value: '1' } })).not.toBe(
      canonicalHash({ network: 'ethereum', payload: { to: '0x2', value: '1' } }),
    )
  })
})
