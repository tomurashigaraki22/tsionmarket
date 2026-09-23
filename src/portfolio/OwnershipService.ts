import { createHash, randomBytes, randomUUID } from 'node:crypto'
import bs58 from 'bs58'
import nacl from 'tweetnacl'
import { getAddress, isAddress, recoverMessageAddress, type Hex } from 'viem'
import { AppError } from '../utils/errors.js'
import { NETWORKS } from './networks.js'
import type { OwnershipChallenge, OwnershipRepository } from './OwnershipRepository.js'

const CHALLENGE_TTL_MS = 5 * 60_000

export type OwnershipProof = {
  challengeId: string
  networkId: string
  address: string
  signature: string
  publicKey?: string | undefined
  label?: string | undefined
  idempotencyKey: string
}

export class OwnershipService {
  constructor(private readonly repository: OwnershipRepository) {}

  async challenge(userId: string, networkId: string, rawAddress: string) {
    const network = NETWORKS.find((candidate) => candidate.networkId === networkId)
    if (!network) throw new AppError('NETWORK_UNSUPPORTED', 'Network is not supported', 400)
    const address = normalizeAddress(network.family, rawAddress)
    const issuedAt = new Date()
    const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_MS)
    const nonce = randomBytes(24).toString('base64url')
    const signatureScheme = network.family === 'evm' ? 'eip191-v1' : 'ed25519-v1'
    const statement = [
      'TsionMarket wallet ownership',
      `User: ${userId}`,
      `Network: ${networkId}`,
      `Address: ${address}`,
      `Nonce: ${nonce}`,
      `Issued at: ${issuedAt.toISOString()}`,
      `Expires at: ${expiresAt.toISOString()}`,
      'This is not a transaction and does not authorize spending.',
    ].join('\n')
    const challenge: OwnershipChallenge = {
      id: randomUUID(),
      userId,
      networkId,
      address,
      nonce,
      statement,
      signatureScheme,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      consumedAt: null,
      failedAttempts: 0,
    }
    await this.repository.createChallenge(challenge)
    return {
      challengeId: challenge.id,
      statement,
      nonce,
      networkId,
      address,
      userId,
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt,
      signatureScheme,
    }
  }

  async register(userId: string, proof: OwnershipProof) {
    const network = NETWORKS.find((candidate) => candidate.networkId === proof.networkId)
    if (!network) throw new AppError('NETWORK_UNSUPPORTED', 'Network is not supported', 400)
    const address = normalizeAddress(network.family, proof.address)
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ ...proof, address, label: proof.label ?? null }))
      .digest('hex')
    return this.repository.register({
      userId,
      challengeId: proof.challengeId,
      networkId: proof.networkId,
      address,
      label: proof.label,
      idempotencyKey: proof.idempotencyKey,
      requestHash,
      verify: (challenge) => verifyOwnership(network.family, challenge, proof),
    })
  }
}

export function normalizeAddress(family: 'evm' | 'solana', address: string): string {
  try {
    if (family === 'evm') {
      if (!isAddress(address)) throw new Error('invalid')
      return getAddress(address)
    }
    return bs58.encode(bs58.decode(address))
  } catch {
    throw new AppError('INVALID_ADDRESS', 'Address is invalid for this network', 400)
  }
}

async function verifyOwnership(
  family: 'evm' | 'solana',
  challenge: OwnershipChallenge,
  proof: OwnershipProof,
): Promise<boolean> {
  try {
    if (family === 'evm') {
      const recovered = await recoverMessageAddress({
        message: challenge.statement,
        signature: proof.signature as Hex,
      })
      return getAddress(recovered) === challenge.address
    }
    if (!proof.publicKey || normalizeAddress('solana', proof.publicKey) !== challenge.address) return false
    return nacl.sign.detached.verify(
      new TextEncoder().encode(challenge.statement),
      bs58.decode(proof.signature),
      bs58.decode(proof.publicKey),
    )
  } catch {
    return false
  }
}
