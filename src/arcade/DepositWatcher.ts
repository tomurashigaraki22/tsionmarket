import type { Pool, RowDataPacket } from 'mysql2/promise'
import { PublicKey } from '@solana/web3.js'
import type { Environment } from '../config/env.js'
import type { RpcManager } from '../portfolio/RpcManager.js'
import { NETWORKS } from '../portfolio/networks.js'
import { withTransaction } from '../db/transaction.js'
import { logger } from '../utils/logger.js'
import { StakeRepository } from './StakeRepository.js'

const NETWORK_ID = 'solana-mainnet-beta'
const ASSET = 'USDC'
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const USDC_DECIMALS = 6
/** Kept small: a public address accrues history fast and this runs often. */
const SCAN_LIMIT = 50

/**
 * Credits game balances from confirmed USDC transfers into the house address.
 *
 * Three things make this safe to run unattended:
 *
 *  1. It only ever READS the chain. Depositing needs no key — the player's own
 *     device signs the transfer — so nothing here can move funds.
 *  2. A transfer is credited only when its sender is a VERIFIED address of an
 *     account. The address is public and will receive transfers that are not
 *     deposits; those are recorded as unattributed and left for a human rather
 *     than credited to whoever is nearby.
 *  3. The signature is the primary key, so a rescan of the same window cannot
 *     credit the same transfer twice.
 */
export class DepositWatcher {
  private readonly stakes = new StakeRepository()
  private timer?: NodeJS.Timeout
  private running = false

  constructor(
    private readonly pool: Pool,
    private readonly rpc: RpcManager,
    private readonly env: Environment,
  ) {}

  start(): void {
    if (!this.env.ARCADE_DEPOSIT_ADDRESS) {
      logger.info('Arcade deposits disabled', { reason: 'no deposit address configured' })
      return
    }
    this.timer = setInterval(
      () => void this.scan(),
      this.env.ARCADE_DEPOSIT_SCAN_INTERVAL_SECONDS * 1000,
    )
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  async scan(): Promise<void> {
    const address = this.env.ARCADE_DEPOSIT_ADDRESS
    if (!address || this.running) return
    this.running = true
    try {
      const network = NETWORKS.find((item) => item.networkId === NETWORK_ID)
      if (!network) return

      const [cursorRows] = await this.pool.execute<RowDataPacket[]>(
        'SELECT last_signature AS lastSignature FROM arcade_deposit_cursor WHERE address = ?',
        [address],
      )
      const until = (cursorRows[0]?.lastSignature as string | null) ?? undefined

      const transfers = await this.rpc.solana(network, async (connection) => {
        const owner = new PublicKey(address)
        const signatures = await connection.getSignaturesForAddress(owner, {
          limit: SCAN_LIMIT,
          ...(until ? { until } : {}),
        })
        const found: Array<Transfer> = []
        for (const entry of signatures) {
          // A failed transaction moved nothing, whatever it intended to.
          if (entry.err) continue
          const parsed = await connection.getParsedTransaction(entry.signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
          })
          if (!parsed) continue
          const transfer = readUsdcTransferTo(parsed, address)
          if (transfer)
            found.push({
              ...transfer,
              signature: entry.signature,
              blockTime: entry.blockTime ?? null,
            })
        }
        return { transfers: found, newest: signatures[0]?.signature ?? until }
      })

      for (const transfer of transfers.transfers) await this.record(transfer)

      await this.pool.execute(
        `INSERT INTO arcade_deposit_cursor (address, last_signature, last_scanned_at, last_error)
         VALUES (?, ?, NOW(6), NULL)
         ON DUPLICATE KEY UPDATE last_signature = VALUES(last_signature),
           last_scanned_at = NOW(6), last_error = NULL`,
        [address, transfers.newest ?? null],
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('Arcade deposit scan failed', { error })
      await this.pool
        .execute(
          `INSERT INTO arcade_deposit_cursor (address, last_error, last_scanned_at)
           VALUES (?, ?, NOW(6))
           ON DUPLICATE KEY UPDATE last_error = VALUES(last_error), last_scanned_at = NOW(6)`,
          [this.env.ARCADE_DEPOSIT_ADDRESS ?? '', message.slice(0, 500)],
        )
        .catch(() => undefined)
    } finally {
      this.running = false
    }
  }

  /**
   * Records one transfer and, if it can be attributed, credits it.
   *
   * Attribution is by SENDER: the address must be one the account proved it
   * controls through the ownership challenge flow. That proof already exists
   * and is exactly the guarantee needed here — it is why a deposit needs no
   * memo, tag or reference the user could mistype.
   */
  private async record(transfer: Transfer): Promise<void> {
    const feeBps = this.env.ARCADE_DEPOSIT_FEE_BPS
    await withTransaction(this.pool, async (connection) => {
      const [owners] = await connection.execute<RowDataPacket[]>(
        `SELECT user_id AS userId FROM wallet_account_ownership
         WHERE network_id = ? AND address = ?`,
        [NETWORK_ID, transfer.from],
      )
      const userId = (owners[0]?.userId as string | undefined) ?? null

      const fee = userId ? bpsOf(transfer.amount, feeBps) : '0'
      const net = userId ? subtractDecimal(transfer.amount, fee) : '0'

      const [inserted] = await connection.execute(
        `INSERT IGNORE INTO arcade_deposits
          (signature, network_id, asset, from_address, gross_amount, fee_amount,
           net_amount, fee_bps, user_id, status, block_time, credited_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          transfer.signature,
          NETWORK_ID,
          ASSET,
          transfer.from,
          transfer.amount,
          fee,
          net,
          userId ? feeBps : 0,
          userId,
          userId ? 'credited' : 'unattributed',
          transfer.blockTime ? new Date(transfer.blockTime * 1000) : null,
          userId ? new Date() : null,
        ],
      )
      // Already seen. The signature key means a rescan is a no-op rather than
      // a second credit.
      if (!(inserted as { affectedRows?: number }).affectedRows) return

      if (!userId) {
        logger.warn('Arcade deposit could not be attributed', {
          signature: transfer.signature,
          from: transfer.from,
        })
        return
      }

      await this.stakes.credit(connection, {
        userId,
        asset: ASSET,
        networkId: NETWORK_ID,
        amount: net,
        memo: `deposit ${transfer.signature.slice(0, 12)} fee ${feeBps}bps`,
      })
      logger.info('Arcade deposit credited', {
        signature: transfer.signature,
        userId,
        net,
        feeBps,
      })
    })
  }
}

type Transfer = { signature: string; from: string; amount: string; blockTime: number | null }

/**
 * Finds a USDC transfer into the house address in a parsed transaction.
 *
 * Reads the token balance deltas rather than trusting an instruction's stated
 * amount: a transfer can be wrapped, batched or routed through a program, and
 * what actually arrived is the difference in the account's balance.
 */
function readUsdcTransferTo(
  parsed: {
    meta?: {
      preTokenBalances?: Array<TokenBalance> | null
      postTokenBalances?: Array<TokenBalance> | null
    } | null
    transaction?: { message?: { accountKeys?: Array<{ pubkey: PublicKey; signer?: boolean }> } }
  },
  address: string,
): { from: string; amount: string } | null {
  const pre = parsed.meta?.preTokenBalances ?? []
  const post = parsed.meta?.postTokenBalances ?? []

  const after = post.find((entry) => entry.mint === USDC_MINT && entry.owner === address)
  if (!after) return null
  const before = pre.find((entry) => entry.mint === USDC_MINT && entry.owner === address)

  const delta =
    BigInt(after.uiTokenAmount.amount) - BigInt(before?.uiTokenAmount.amount ?? '0')
  if (delta <= 0n) return null

  // The sender is whichever USDC account went down, which survives a routed
  // transfer where the fee payer is not the sender.
  const senders = post
    .filter((entry) => entry.mint === USDC_MINT && entry.owner && entry.owner !== address)
    .map((entry) => {
      const previous = pre.find((item) => item.accountIndex === entry.accountIndex)
      return {
        owner: entry.owner as string,
        spent:
          BigInt(previous?.uiTokenAmount.amount ?? '0') - BigInt(entry.uiTokenAmount.amount),
      }
    })
    .filter((entry) => entry.spent > 0n)
    .sort((a, b) => (a.spent > b.spent ? -1 : 1))

  const from =
    senders[0]?.owner ??
    parsed.transaction?.message?.accountKeys?.find((key) => key.signer)?.pubkey.toBase58()
  if (!from) return null

  return { from, amount: fromBaseUnits(delta, USDC_DECIMALS) }
}

type TokenBalance = {
  accountIndex: number
  mint: string
  owner?: string | undefined
  uiTokenAmount: { amount: string }
}

function fromBaseUnits(units: bigint, decimals: number): string {
  const digits = units.toString().padStart(decimals + 1, '0')
  const fraction = digits.slice(-decimals).replace(/0+$/, '')
  return `${digits.slice(0, -decimals)}${fraction ? `.${fraction}` : ''}`
}

const SCALE = 18
function scale(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.')
  return BigInt(whole + fraction.padEnd(SCALE, '0').slice(0, SCALE))
}
function unscale(units: bigint): string {
  const digits = units.toString().padStart(SCALE + 1, '0')
  const fraction = digits.slice(-SCALE).replace(/0+$/, '')
  return `${digits.slice(0, -SCALE)}${fraction ? `.${fraction}` : ''}`
}
/**
 * Rounds down, so the fee can never exceed what arrived.
 *
 * Quantised to the asset's own precision, not the ledger's eighteen places.
 * USDC has six decimals, so a fee of 0.000000001 is not a small fee — it is an
 * amount that cannot exist on chain, and carrying it would leave an internal
 * balance that could never be paid out exactly. Dust therefore costs the house
 * rather than the player.
 */
export function bpsOf(amount: string, bps: number, decimals = USDC_DECIMALS): string {
  const exact = (scale(amount) * BigInt(bps)) / 10_000n
  const step = 10n ** BigInt(SCALE - decimals)
  return unscale((exact / step) * step)
}
export function subtractDecimal(left: string, right: string): string {
  return unscale(scale(left) - scale(right))
}
