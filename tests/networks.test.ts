import { describe, expect, it } from 'vitest'
import { enabledNetworks, NETWORKS } from '../src/portfolio/networks.js'
import { parseEnvironment } from '../src/config/env.js'
import { RpcManager } from '../src/portfolio/RpcManager.js'

const database = {
  MYSQL_HOST: 'localhost',
  MYSQL_DATABASE: 'test',
  MYSQL_USER: 'test',
  MYSQL_PASSWORD: 'test',
  MYSQL_MIGRATION_USER: 'migrator',
  MYSQL_MIGRATION_PASSWORD: 'test',
}

describe('network and RPC policy', () => {
  it('never mixes mainnet into development mode', () => {
    expect(enabledNetworks('development').every((network) => network.environment !== 'mainnet')).toBe(true)
    expect(enabledNetworks('mainnet').every((network) => network.environment === 'mainnet')).toBe(true)
  })

  it('uses the shared ordered RPC keys and removes duplicates', () => {
    const environment = parseEnvironment({
      ...database,
      NETWORK_MODE: 'mainnet',
      ETHEREUM_RPC_URLS: 'https://one.invalid,https://two.invalid',
      ETHEREUM_RPC_URL: 'https://one.invalid',
      ETHEREUM_FALLBACK_RPC_URL: 'https://three.invalid',
    })
    const network = NETWORKS.find((candidate) => candidate.networkId === 'ethereum-mainnet')!
    expect(new RpcManager(environment).urls(network)).toEqual([
      'https://one.invalid',
      'https://two.invalid',
      'https://three.invalid',
    ])
  })

  it('pins Solana devnet independently of environment RPC values', () => {
    const environment = parseEnvironment({ ...database, SOLANA_RPC_URL: 'https://mainnet.invalid' })
    const network = NETWORKS.find((candidate) => candidate.networkId === 'solana-devnet')!
    expect(new RpcManager(environment).urls(network)).toEqual(['https://api.devnet.solana.com'])
  })
})
