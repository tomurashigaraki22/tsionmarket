import bs58 from 'bs58'
import nacl from 'tweetnacl'
import { describe, expect, it, vi } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { OwnershipService } from '../src/portfolio/OwnershipService.js'
import type { OwnershipChallenge, OwnershipRepository } from '../src/portfolio/OwnershipRepository.js'

function serviceHarness() {
  let challenge: OwnershipChallenge | undefined
  const repository = {
    createChallenge: vi.fn((value: OwnershipChallenge) => {
      challenge = value
      return Promise.resolve()
    }),
    register: vi.fn(async (input: { verify: (value: OwnershipChallenge) => Promise<boolean> }) => {
      if (!challenge || !(await input.verify(challenge))) throw new Error('invalid proof')
      return { id: 'account-id', existing: false }
    }),
  } as unknown as OwnershipRepository
  return { service: new OwnershipService(repository), repository }
}

describe('wallet ownership service', () => {
  it('binds an EIP-191 proof to user, network, address, nonce, and expiry', async () => {
    const { service, repository } = serviceHarness()
    const signer = privateKeyToAccount(generatePrivateKey())
    const challenge = await service.challenge('user-a', 'ethereum-mainnet', signer.address)
    expect(challenge.statement).toContain('User: user-a')
    expect(challenge.statement).toContain('Network: ethereum-mainnet')
    expect(challenge.statement).toContain('This is not a transaction')
    const signature = await signer.signMessage({ message: challenge.statement })
    await expect(
      service.register('user-a', {
        challengeId: challenge.challengeId,
        networkId: challenge.networkId,
        address: signer.address,
        signature,
        idempotencyKey: 'registration-one',
      }),
    ).resolves.toEqual({ id: 'account-id', existing: false })
    expect(repository.register).toHaveBeenCalledOnce()
  })

  it('verifies Solana public key ownership and rejects malformed signatures', async () => {
    const valid = serviceHarness()
    const keypair = nacl.sign.keyPair()
    const address = bs58.encode(keypair.publicKey)
    const challenge = await valid.service.challenge('user-b', 'solana-mainnet-beta', address)
    const signature = bs58.encode(
      nacl.sign.detached(new TextEncoder().encode(challenge.statement), keypair.secretKey),
    )
    await expect(
      valid.service.register('user-b', {
        challengeId: challenge.challengeId,
        networkId: challenge.networkId,
        address,
        signature,
        publicKey: address,
        idempotencyKey: 'registration-two',
      }),
    ).resolves.toBeDefined()

    const invalid = serviceHarness()
    const other = await invalid.service.challenge('user-b', 'solana-mainnet-beta', address)
    await expect(
      invalid.service.register('user-b', {
        challengeId: other.challengeId,
        networkId: other.networkId,
        address,
        signature: 'malformed-signature',
        publicKey: address,
        idempotencyKey: 'registration-three',
      }),
    ).rejects.toThrow('invalid proof')
  })
})
