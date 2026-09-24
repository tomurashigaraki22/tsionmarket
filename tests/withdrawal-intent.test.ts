import { createHash } from 'node:crypto'
import { bech32m } from '@scure/base'
import nacl from 'tweetnacl'
import { describe, expect, it, vi } from 'vitest'
import type { Environment } from '../src/config/env.js'
import type { RpcManager } from '../src/portfolio/RpcManager.js'
import type { TradingRepository } from '../src/trading/TradingRepository.js'
import { WithdrawalIntentService } from '../src/trading/WithdrawalIntentService.js'

function intertrainAddress(publicKey: Uint8Array): string {
  const digest = createHash('sha256')
    .update(Buffer.concat([Buffer.from('MNA/address/v1'), Buffer.from(publicKey)]))
    .digest()
  return bech32m.encodeFromBytes('mna', Buffer.concat([Buffer.from([1]), digest.subarray(0, 20)]))
}

function setupIntertrain(balance: string, feeMinimum: string | null = '100') {
  const owner = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7))
  const recipient = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9))
  const account = {
    id: 'account-id',
    networkId: 'intertrain-mainnet',
    address: intertrainAddress(owner.publicKey),
    family: 'intertrain',
    chainId: 4683,
  }
  const repo = {
    existingIntent: vi.fn().mockResolvedValue(null),
    account: vi.fn().mockResolvedValue(account),
    createIntent: vi.fn(async (input: Parameters<TradingRepository['createIntent']>[0]) => ({
      id: 'intent-id',
      accountId: input.accountId,
      quoteId: input.quoteId,
      status: 'awaiting_signature',
      intentType: input.type,
      chainFamily: input.family,
      networkId: input.networkId,
      unsignedTransaction: input.unsigned,
      normalizedSummary: input.summary,
      payloadHash: 'payload-hash',
      payloadVersion: 1,
      expiresAt: new Date(Date.now() + 300_000),
    })),
  }
  const rpc = {
    intertrainRequest: vi.fn(async (_network: unknown, method: string) => {
      if (method === 'chain_info')
        return {
          chain_id: 'intertrain-1',
          native_asset: { symbol: 'WSK', decimals: 6 },
          ...(feeMinimum === null ? {} : { fee_minimum: feeMinimum }),
        }
      return { address: account.address, balance, nonce: 3 }
    }),
  }
  const environment = { TRANSACTION_INTENT_TTL_SECONDS: 300 }
  return {
    owner,
    recipient,
    account,
    repo,
    service: new WithdrawalIntentService(
      repo as unknown as TradingRepository,
      rpc as unknown as RpcManager,
      environment as Environment,
    ),
  }
}

describe('wallet withdrawal intents', () => {
  it('rejects zero amounts before loading an account or contacting a provider', async () => {
    const repo = {
      existingIntent: vi.fn().mockResolvedValue(null),
      account: vi.fn(),
    }
    const service = new WithdrawalIntentService(
      repo as unknown as TradingRepository,
      {} as RpcManager,
      {} as Environment,
    )

    await expect(
      service.create('user-id', {
        accountId: 'account-id',
        assetId: 'native',
        toAddress: 'mna1recipient',
        amountRaw: '0',
        idempotencyKey: 'withdrawal-key-1',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_WITHDRAWAL_AMOUNT' })
    expect(repo.account).not.toHaveBeenCalled()
  })

  it('prepares a verified native WSK transfer with the live fee and nonce', async () => {
    const { owner, recipient, account, repo, service } = setupIntertrain('5000000')
    const result = await service.create('user-id', {
      accountId: account.id,
      assetId: 'native',
      toAddress: intertrainAddress(recipient.publicKey),
      amountRaw: '1000000',
      idempotencyKey: 'withdrawal-key-2',
      publicKey: Buffer.from(owner.publicKey).toString('hex'),
    })

    expect(result.intent.chainFamily).toBe('intertrain')
    expect(result.intent.intentType).toBe('withdrawal')
    expect(result.intent.unsignedTransaction).toMatchObject({
      from: account.address,
      to: intertrainAddress(recipient.publicKey),
      payload: {
        nonce: 3,
        amountRaw: '1000000',
        feeRaw: '100',
        chainId: 'intertrain-1',
      },
    })
    expect(repo.createIntent).toHaveBeenCalledOnce()
  })

  it('uses the web-wallet default fee when chain_info omits fee_minimum', async () => {
    const { owner, recipient, account, repo, service } = setupIntertrain(
      '5000000',
      null,
    )
    const result = await service.create('user-id', {
      accountId: account.id,
      assetId: 'native',
      toAddress: intertrainAddress(recipient.publicKey),
      amountRaw: '1000000',
      idempotencyKey: 'withdrawal-key-default-fee',
      publicKey: Buffer.from(owner.publicKey).toString('hex'),
    })

    expect(result.intent.unsignedTransaction).toMatchObject({
      payload: { feeRaw: '1' },
    })
    expect(result.intent.normalizedSummary).toMatchObject({
      estimatedNetworkFeeRaw: '1',
      networkFeeSymbol: 'WSK',
    })
    expect(repo.createIntent).toHaveBeenCalledOnce()
  })

  it('reserves native funds for the network fee before creating an intent', async () => {
    const { owner, recipient, account, repo, service } = setupIntertrain('5000000')

    await expect(
      service.create('user-id', {
        accountId: account.id,
        assetId: 'native',
        toAddress: intertrainAddress(recipient.publicKey),
        amountRaw: '4999999',
        idempotencyKey: 'withdrawal-key-3',
        publicKey: Buffer.from(owner.publicKey).toString('hex'),
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FEE_BALANCE' })
    expect(repo.createIntent).not.toHaveBeenCalled()
  })
})
