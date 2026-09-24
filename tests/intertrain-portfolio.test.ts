import { describe, expect, it } from 'vitest'
import { NETWORKS, enabledNetworks } from '../src/portfolio/networks.js'
import {
  isExpectedIntertrainChain,
  isIntertrainReservePriceable,
  parseIntertrainNativeBalance,
} from '../src/portfolio/intertrain.js'
import { intertrainUsdcBridgeStatus } from '../src/portfolio/intertrainBridgeStatus.js'

describe('Intertrain native WSK portfolio support', () => {
  it('registers Intertrain as a mainnet-only native WSK network', () => {
    const network = NETWORKS.find((candidate) => candidate.networkId === 'intertrain-mainnet')
    expect(network).toMatchObject({
      family: 'intertrain',
      environment: 'mainnet',
      nativeSymbol: 'WSK',
      nativeDecimals: 6,
    })
    expect(enabledNetworks('development')).not.toContain(network)
    expect(enabledNetworks('mainnet')).toContain(network)
  })

  it('requires the expected chain identity and native asset before reading balances', () => {
    expect(
      isExpectedIntertrainChain({
        chain_id: 'intertrain-1',
        native_asset: { symbol: 'WSK', decimals: 6 },
      }),
    ).toBe(true)
    expect(
      isExpectedIntertrainChain({
        chain_id: 'intertrain-testnet',
        native_asset: { symbol: 'WSK', decimals: 6 },
      }),
    ).toBe(false)
    expect(
      isExpectedIntertrainChain({
        chain_id: 'intertrain-1',
        native_asset: { symbol: 'MNA', decimals: 6 },
      }),
    ).toBe(false)
  })

  it('accepts integer micro-WSK balances only', () => {
    expect(parseIntertrainNativeBalance({ balance: '1200000' })).toBe('1200000')
    expect(parseIntertrainNativeBalance({ balance: 0 })).toBe('0')
    expect(parseIntertrainNativeBalance({ balance: '1.2' })).toBeNull()
    expect(parseIntertrainNativeBalance({})).toBeNull()
  })

  it('values WSK at one dollar only when the live reserve is exact-rate, active, and fully backed', () => {
    const healthy = {
      paused: false,
      collateralized: true,
      rate: '1 USDC = 1 WSK',
      total_mna_supply: '1000000',
      reserve_backed_mna_minted: '1000000',
      current_reserves_total_usd: '1000000',
      required_reserve_usd: '1000000',
    }
    expect(isIntertrainReservePriceable(healthy)).toBe(true)
    expect(isIntertrainReservePriceable({ ...healthy, paused: true })).toBe(false)
    expect(isIntertrainReservePriceable({ ...healthy, collateralized: false })).toBe(false)
    expect(isIntertrainReservePriceable({ ...healthy, rate: '2 USDC = 1 WSK' })).toBe(false)
    expect(isIntertrainReservePriceable({ ...healthy, reserve_backed_mna_minted: '999999' })).toBe(false)
    expect(isIntertrainReservePriceable({ ...healthy, current_reserves_total_usd: '999999' })).toBe(false)
    expect(
      isIntertrainReservePriceable({ ...healthy, total_mna_supply: '0', reserve_backed_mna_minted: '0' }),
    ).toBe(false)
  })

  it('keeps Arbitrum USDC to native WSK read-only until destination credit verification is implemented', () => {
    expect(intertrainUsdcBridgeStatus()).toMatchObject({
      available: false,
      source: { networkId: 'arbitrum-one', asset: 'USDC', decimals: 6 },
      destination: { networkId: 'intertrain-mainnet', asset: 'WSK', kind: 'native', decimals: 6 },
    })
  })
})
