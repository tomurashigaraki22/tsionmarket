import { createHash } from 'node:crypto'
import bs58 from 'bs58'
import nacl from 'tweetnacl'
import { VersionedTransaction } from '@solana/web3.js'
import { keccak256, parseTransaction, recoverTransactionAddress, type TransactionSerialized } from 'viem'
import type { Environment } from '../config/env.js'
import { NETWORKS } from '../portfolio/networks.js'
import type { RpcManager } from '../portfolio/RpcManager.js'
import { AppError } from '../utils/errors.js'
import { increment } from '../observability/metrics.js'
import type { StoredIntent, TransactionRepository } from './TransactionRepository.js'

const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const optionalBigInt = (value: unknown): bigint | undefined =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint'
    ? BigInt(value)
    : undefined
export class TransactionService {
  constructor(
    private repo: TransactionRepository,
    private rpc: RpcManager,
    private env: Environment,
  ) {}
  async submit(userId: string, intentId: string, signed: string, requestId?: string) {
    if (await this.repo.control('transaction_submission_paused'))
      throw new AppError('EXECUTION_PAUSED', 'Transaction submission is paused', 503)
    if (Buffer.byteLength(signed) > this.env.SUBMISSION_MAX_BYTES)
      throw new AppError('PAYLOAD_TOO_LARGE', 'Signed transaction is too large', 413)
    const intent = await this.repo.intent(userId, intentId)
    if (!intent) throw new AppError('INTENT_NOT_FOUND', 'Transaction intent not found', 404)
    const prior = await this.repo.recordForIntent(userId, intentId)
    if (prior) return { record: prior, existing: true }
    if (intent.expiresAt.getTime() <= Date.now())
      throw new AppError('INTENT_EXPIRED', 'Transaction intent has expired', 409)
    let txHash: string, broadcast: () => Promise<string>
    try {
      if (intent.chainFamily === 'evm') ({ txHash, broadcast } = await this.verifyEvm(intent, signed))
      else ({ txHash, broadcast } = this.verifySolana(intent, signed))
    } catch (error) {
      increment('submission_rejected_total')
      await this.repo.securityEvent({
        userId,
        type: 'signed_transaction_rejected',
        outcome: 'denied',
        ...(requestId ? { requestId } : {}),
        metadata: { intentId, code: error instanceof AppError ? error.code : 'INVALID_SIGNATURE' },
      })
      throw error
    }
    const claim = await this.repo.claim(intent, txHash, sha(signed))
    if (!claim.claimed) {
      const record = await this.repo.recordForIntent(userId, intentId)
      return { record, existing: true }
    }
    try {
      const providerHash = await broadcast()
      if (providerHash.toLowerCase() !== txHash.toLowerCase())
        throw new Error('Provider returned a different transaction hash')
      await this.repo.markBroadcast(claim.id)
      increment('submission_accepted_total')
    } catch (error) {
      await this.repo.markBroadcastUnknown(claim.id, error instanceof Error ? error.message : String(error))
      increment('submission_unknown_total')
    }
    return { record: await this.repo.get(userId, claim.id), existing: false }
  }
  private async verifyEvm(intent: StoredIntent, signed: string) {
    if (!/^0x[0-9a-f]+$/i.test(signed))
      throw new AppError('SIGNED_TRANSACTION_INVALID', 'Expected a hex-encoded signed EVM transaction', 400)
    const raw = signed as TransactionSerialized,
      parsed = parseTransaction(raw),
      signer = await recoverTransactionAddress({ serializedTransaction: raw }),
      payload = (intent.unsignedTransaction.payload ?? {}) as Record<string, unknown>
    const mismatch =
      signer.toLowerCase() !== intent.address.toLowerCase() ||
      parsed.chainId !== Number(payload.chainId) ||
      parsed.to?.toLowerCase() !== String(intent.unsignedTransaction.to).toLowerCase() ||
      (parsed.data ?? '0x').toLowerCase() !== String(payload.data).toLowerCase() ||
      parsed.value !== BigInt(String(payload.value)) ||
      parsed.nonce !== Number(payload.nonce) ||
      parsed.gas !== BigInt(String(payload.gas)) ||
      (payload.maxFeePerGas !== undefined && parsed.maxFeePerGas !== optionalBigInt(payload.maxFeePerGas)) ||
      (payload.maxPriorityFeePerGas !== undefined &&
        parsed.maxPriorityFeePerGas !== optionalBigInt(payload.maxPriorityFeePerGas)) ||
      (payload.gasPrice !== undefined && parsed.gasPrice !== optionalBigInt(payload.gasPrice))
    if (mismatch)
      throw new AppError(
        'SIGNED_TRANSACTION_MISMATCH',
        'Signed transaction does not match the reviewed intent',
        400,
      )
    const network = NETWORKS.find((n) => n.networkId === intent.networkId)!
    return {
      txHash: keccak256(raw),
      broadcast: async () => this.rpc.evmClient(network).sendRawTransaction({ serializedTransaction: raw }),
    }
  }
  private verifySolana(intent: StoredIntent, signed: string) {
    let transaction: VersionedTransaction, unsigned: VersionedTransaction
    try {
      transaction = VersionedTransaction.deserialize(Buffer.from(signed, 'base64'))
      const payload = intent.unsignedTransaction.payload as Record<string, unknown>
      unsigned = VersionedTransaction.deserialize(
        Buffer.from(String(payload.serializedTransaction), 'base64'),
      )
    } catch {
      throw new AppError('SIGNED_TRANSACTION_INVALID', 'Expected a base64 signed Solana transaction', 400)
    }
    if (!Buffer.from(transaction.message.serialize()).equals(Buffer.from(unsigned.message.serialize())))
      throw new AppError(
        'SIGNED_TRANSACTION_MISMATCH',
        'Signed Solana message does not match the reviewed intent',
        400,
      )
    const message = transaction.message.serialize(),
      keys = transaction.message.staticAccountKeys
    for (let index = 0; index < transaction.signatures.length; index++) {
      const signature = transaction.signatures[index]!
      if (
        signature.every((byte) => byte === 0) ||
        !nacl.sign.detached.verify(message, signature, keys[index]!.toBytes())
      )
        throw new AppError('SIGNED_TRANSACTION_INVALID', 'Solana signature verification failed', 400)
    }
    const txHash = bs58.encode(transaction.signatures[0]!),
      network = NETWORKS.find((n) => n.networkId === intent.networkId)!
    return {
      txHash,
      broadcast: async () =>
        this.rpc.solana(network, (c) =>
          c.sendRawTransaction(transaction.serialize(), { skipPreflight: false, maxRetries: 2 }),
        ),
    }
  }
}
