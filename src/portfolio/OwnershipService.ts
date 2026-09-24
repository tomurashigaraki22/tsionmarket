import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { bech32m } from '@scure/base'
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
    const signatureScheme =
      network.family === 'evm'
        ? 'eip191-v1'
        : network.family === 'intertrain'
          ? 'intertrain-ed25519-v1'
          : 'ed25519-v1'
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

export function normalizeAddress(family: 'evm' | 'solana' | 'intertrain', address: string): string {
  try {
    if (family === 'evm') {
      if (!isAddress(address)) throw new Error('invalid')
      return getAddress(address)
    }
    if (family === 'intertrain') {
      const decoded = bech32m.decodeToBytes(address.trim())
      if (decoded.prefix !== 'mna' || decoded.bytes.length !== 21 || decoded.bytes[0] !== 1)
        throw new Error('invalid')
      return bech32m.encodeFromBytes('mna', decoded.bytes)
    }
    return bs58.encode(bs58.decode(address))
  } catch {
    throw new AppError('INVALID_ADDRESS', 'Address is invalid for this network', 400)
  }
}

async function verifyOwnership(
  family: 'evm' | 'solana' | 'intertrain',
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
    if (family === 'intertrain') {
      if (!proof.publicKey) return false
      const publicKey = hexBytes(proof.publicKey)
      const signature = hexBytes(proof.signature)
      if (!publicKey || publicKey.length !== 32 || !signature || signature.length !== 64) return false
      const digest = createHash('sha256')
        .update(Buffer.concat([Buffer.from('MNA/address/v1'), Buffer.from(publicKey)]))
        .digest()
      const addressBytes = Buffer.concat([Buffer.from([1]), digest.subarray(0, 20)])
      const derivedAddress = bech32m.encodeFromBytes('mna', addressBytes)
      return (
        derivedAddress === challenge.address &&
        nacl.sign.detached.verify(new TextEncoder().encode(challenge.statement), signature, publicKey)
      )
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

function hexBytes(value: string): Uint8Array | null {
  const normalized = value.replace(/^0x/i, '')
  if (!/^(?:[0-9a-f]{2})+$/i.test(normalized)) return null
  return Uint8Array.from(normalized.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)))
}
