import { createHash } from 'node:crypto'
import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import {
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
  getAccount,
} from '@solana/spl-token'
import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { Environment } from '../config/env.js'
import type { RpcManager } from '../portfolio/RpcManager.js'
import { NETWORKS } from '../portfolio/networks.js'
import { AppError } from '../utils/errors.js'
import { bpsOf, subtractDecimal } from './DepositWatcher.js'

const NETWORK_ID = 'solana-mainnet-beta'
const ASSET = 'USDC'
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
const USDC_DECIMALS = 6
/** The SPL Memo program. Writes a note onto the transaction itself. */
const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')

/**
 * Builds the unsigned transfer that funds a game balance.
 *
 * Built on the server because only the server has an RPC endpoint, the house
 * address and the fee — but signed on the device, through exactly the same
 * path a swap takes. That path verifies the payload hash and refuses to sign
 * if the fee payer is not the account it was asked for, which is the property
 * that makes a server-built transaction safe to sign: the device checks what
 * it was handed rather than trusting it.
 */
export class DepositIntentService {
  constructor(
    private readonly pool: Pool,
    private readonly rpc: RpcManager,
    private readonly env: Environment,
  ) {}

  async build(userId: string, amount: string) {
    const house = this.env.ARCADE_DEPOSIT_ADDRESS
    if (!house) throw new AppError('DEPOSITS_DISABLED', 'Deposits are not enabled', 503)

    const units = toBaseUnits(amount, USDC_DECIMALS)
    if (units <= 0n) throw new AppError('INVALID_AMOUNT', 'Enter an amount above zero', 400)

    // The sender must be an address this account proved it controls, because
    // that is how the deposit will be attributed when it lands.
    const [owned] = await this.pool.execute<RowDataPacket[]>(
      `SELECT address FROM wallet_account_ownership
       WHERE user_id = ? AND network_id = ? LIMIT 1`,
      [userId, NETWORK_ID],
    )
    const from = owned[0]?.address as string | undefined
    if (!from)
      throw new AppError(
        'NO_VERIFIED_SOLANA_ADDRESS',
        'Verify a Solana address before depositing',
        409,
      )

    const network = NETWORKS.find((item) => item.networkId === NETWORK_ID)
    if (!network) throw new AppError('NETWORK_UNSUPPORTED', 'Network is not supported', 400)

    const sender = new PublicKey(from)
    const recipient = new PublicKey(house)
    const feeBps = this.env.ARCADE_DEPOSIT_FEE_BPS
    const fee = bpsOf(amount, feeBps)
    const credited = subtractDecimal(amount, fee)

    const transaction = await this.rpc.solana(network, async (connection) => {
      const fromAta = await getAssociatedTokenAddress(USDC_MINT, sender)
      const toAta = await getAssociatedTokenAddress(USDC_MINT, recipient)

      // The house account must already exist. Creating it from a player's
      // transaction would charge them rent for our account, and a missing one
      // is an operator problem rather than something to paper over.
      try {
        await getAccount(connection, toAta)
      } catch {
        throw new AppError(
          'DEPOSITS_UNAVAILABLE',
          'The deposit account is not ready. Try again shortly.',
          503,
        )
      }

      const instructions: Array<TransactionInstruction> = [
        createTransferCheckedInstruction(
          fromAta,
          USDC_MINT,
          toAta,
          sender,
          units,
          USDC_DECIMALS,
        ),
        // Says on chain what the transfer was for. Useful to the player and to
        // support later; attribution still comes from the sender, which cannot
        // be mistyped the way a memo can be stripped or altered.
        new TransactionInstruction({
          keys: [],
          programId: MEMO_PROGRAM,
          data: Buffer.from(
            `TsionMarket Arcade deposit · ${credited} of ${amount} ${ASSET} credited · fee ${feeBps}bps`,
            'utf8',
          ),
        }),
      ]

      const { blockhash } = await connection.getLatestBlockhash('confirmed')
      return new VersionedTransaction(
        new TransactionMessage({
          payerKey: sender,
          recentBlockhash: blockhash,
          instructions,
        }).compileToV0Message(),
      )
    })

    const serialized = Buffer.from(transaction.serialize()).toString('base64')
    const unsignedTransaction = {
      from,
      to: house,
      payload: { kind: 'solana_transfer', serializedTransaction: serialized },
    }

    return {
      intent: {
        id: `deposit-${createHash('sha256').update(serialized).digest('hex').slice(0, 32)}`,
        accountId: from,
        quoteId: '',
        status: 'ready',
        intentType: 'swap' as const,
        chainFamily: 'solana' as const,
        networkId: NETWORK_ID,
        unsignedTransaction,
        normalizedSummary: {
          action: 'Fund your Arcade balance',
          amount: `${amount} ${ASSET}`,
          fee: `${fee} ${ASSET} (${feeBps} bps)`,
          credited: `${credited} ${ASSET}`,
          to: house,
        },
        payloadHash: canonicalHash(unsignedTransaction),
        payloadVersion: 1,
        // A blockhash is only good for a couple of minutes, so the quote for
        // signing expires with it rather than failing at broadcast.
        expiresAt: new Date(Date.now() + 90_000).toISOString(),
      },
      breakdown: { amount, fee, credited, feeBps, asset: ASSET, to: house, from },
    }
  }

  /** Broadcasts the signed transfer and returns its signature. */
  async submit(signedTransaction: string): Promise<{ signature: string }> {
    const network = NETWORKS.find((item) => item.networkId === NETWORK_ID)
    if (!network) throw new AppError('NETWORK_UNSUPPORTED', 'Network is not supported', 400)

    const signature = await this.rpc.solana(network, (connection) =>
      connection.sendRawTransaction(Buffer.from(signedTransaction, 'base64'), {
        maxRetries: 3,
      }),
    )
    // The watcher credits the balance once the transfer confirms. Crediting
    // here, from the client's word that it broadcast something, would credit a
    // transaction that never lands.
    return { signature }
  }
}

function toBaseUnits(value: string, decimals: number): bigint {
  const [whole = '0', fraction = ''] = value.trim().split('.')
  return BigInt(whole + fraction.padEnd(decimals, '0').slice(0, decimals))
}

/**
 * Matches the frontend's canonical hash byte for byte: the device recomputes
 * it and refuses to sign on a mismatch.
 */
function canonicalHash(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical)
    if (input && typeof input === 'object')
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, canonical(entry)]),
      )
    return input
  }
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}
