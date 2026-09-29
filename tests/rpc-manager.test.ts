import { describe, expect, it } from 'vitest'
import { RpcManager, redactRpcUrl } from '../src/portfolio/RpcManager.js'
import { AppError } from '../src/utils/errors.js'
import type { Environment } from '../src/config/env.js'
import type { Network } from '../src/portfolio/networks.js'

const network = {
  networkId: 'solana-mainnet-beta',
  family: 'solana',
  name: 'Solana Mainnet-Beta',
  environment: 'mainnet',
  cluster: 'mainnet-beta',
  nativeSymbol: 'SOL',
  nativeDecimals: 9,
  rpcKeys: ['SOLANA_MAINNET_RPC_URLS'],
} as unknown as Network

const env = {
  SOLANA_MAINNET_RPC_URLS:
    'https://one.example.com/aaaa,https://two.example.com/bbbb',
  RPC_TIMEOUT_MS: 1000,
  RPC_PROVIDER_COOLDOWN_MS: 60_000,
  RPC_MAX_RETRIES: 0,
} as unknown as Environment

describe('RpcManager.solana', () => {
  it('surfaces a business rejection instead of calling it a provider failure', async () => {
    // "No USDC token account exists for this wallet" is the withdrawal
    // refusing on its own terms. Reporting it as an RPC outage sent people
    // looking at their node provider for a problem with their balance.
    let attempts = 0
    const manager = new RpcManager(env)
    const run = manager.solana(network, async () => {
      attempts += 1
      throw new AppError(
        'INSUFFICIENT_ASSET_BALANCE',
        'No USDC token account exists for this wallet',
        409,
      )
    })

    await expect(run).rejects.toMatchObject({
      code: 'INSUFFICIENT_ASSET_BALANCE',
    })
    // And it must not have burned the second provider on the way out.
    expect(attempts).toBe(1)
  })

  it('still fails over when the provider itself is at fault', async () => {
    let attempts = 0
    const manager = new RpcManager(env)
    const run = manager.solana(network, async () => {
      attempts += 1
      throw new Error('fetch failed')
    })

    await expect(run).rejects.toMatchObject({
      code: 'RPC_ALL_PROVIDERS_FAILED',
    })
    expect(attempts).toBe(2)
  })

  it('names the providers and reasons it actually saw', async () => {
    const manager = new RpcManager(env)
    const error = await manager
      .solana(network, async () => {
        throw new Error('403 Forbidden')
      })
      .catch((caught: unknown) => caught as AppError)

    expect(error.message).toContain('403 Forbidden')
    expect(error.message).toContain('one.example.com')
    // The key in the path is a credential and must not ride along.
    expect(error.message).not.toContain('aaaa')
  })

  it('reports a missing configuration as such, not as a failure', async () => {
    const manager = new RpcManager({
      ...env,
      SOLANA_MAINNET_RPC_URLS: '',
    } as unknown as Environment)

    await expect(
      manager.solana(network, async () => 'unreachable'),
    ).rejects.toMatchObject({ code: 'RPC_NOT_CONFIGURED' })
  })
})

describe('redactRpcUrl', () => {
  it('keeps the host so two providers can be told apart', () => {
    expect(redactRpcUrl('https://api.mainnet-beta.solana.com')).toBe(
      'api.mainnet-beta.solana.com',
    )
  })

  it('never reveals the API key providers put in the path', () => {
    const key = 'c4bdb044be1e27cf5f436fa01a427774'
    const redacted = redactRpcUrl(
      `https://solana-mainnet.core.chainstack.com/${key}`,
    )
    expect(redacted).not.toContain(key)
    expect(redacted).toBe('solana-mainnet.core.chainstack.com/…')
  })

  it('hides an Alchemy key while keeping the route that identifies it', () => {
    const redacted = redactRpcUrl(
      'https://solana-mainnet.g.alchemy.com/v2/alch_Fq751a8ZDwvS1gwrhiX8',
    )
    expect(redacted).not.toContain('alch_')
    expect(redacted).toBe('solana-mainnet.g.alchemy.com/v2')
  })

  it('keeps a segment known to be a route', () => {
    expect(redactRpcUrl('https://rpc.intertrain.online/rpc')).toBe(
      'rpc.intertrain.online/rpc',
    )
  })

  it('redacts a short unrecognised segment, since a short key is still a key', () => {
    expect(redactRpcUrl('https://one.example.com/aaaa')).toBe(
      'one.example.com/…',
    )
  })

  it('does not leak a key passed as a query parameter', () => {
    expect(
      redactRpcUrl('https://rpc.example.com/v1?api-key=supersecretvalue'),
    ).not.toContain('supersecretvalue')
  })

  it('says so rather than echoing something it could not parse', () => {
    expect(redactRpcUrl('not a url')).toBe('malformed-rpc-url')
    expect(redactRpcUrl('')).toBe('malformed-rpc-url')
  })
})
