/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- mysql2 rows are normalized at this boundary */
import { randomUUID, createHash } from 'node:crypto'
import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { LifiQuote, OwnedAccount, QuoteRecord } from './types.js'

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stable(item)]),
    )
  return value
}
export const canonicalHash = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex')
export class TradingRepository {
  constructor(private pool: Pool) {}
  async account(userId: string, id: string): Promise<OwnedAccount | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT a.id,a.network_id AS networkId,a.address,n.family,n.chain_id AS chainId FROM wallet_accounts a JOIN networks n ON n.network_id=a.network_id AND n.enabled=TRUE WHERE a.id=? AND a.user_id=? AND a.status='active'`,
      [id, userId],
    )
    return (rows[0] as OwnedAccount | undefined) ?? null
  }
  async market(marketId: string) {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT market_id AS marketId,network_id AS networkId,base_token AS baseToken,quote_token AS quoteToken,decimals,active FROM spot_markets WHERE market_id=?`,
      [marketId],
    )
    return rows[0]
  }
  async createQuote(input: {
    userId: string
    source: OwnedAccount
    destination: OwnedAccount
    marketId?: string
    sellToken: string
    buyToken: string
    sellAmountRaw: string
    sellDecimals: number
    buyDecimals: number
    slippageBps: number
    quote: LifiQuote
    integrator: string
    ttl: number
  }) {
    const id = randomUUID(),
      expires = new Date(Date.now() + input.ttl * 1000),
      requestHash = canonicalHash({
        sourceAccountId: input.source.id,
        destinationAccountId: input.destination.id,
        sellToken: input.sellToken,
        buyToken: input.buyToken,
        sellAmountRaw: input.sellAmountRaw,
        slippageBps: input.slippageBps,
      })
    await this.pool.execute(
      `INSERT INTO swap_quotes(id,user_id,source_account_id,destination_account_id,market_id,provider,integrator,source_network_id,destination_network_id,sell_token,buy_token,sell_amount_raw,buy_amount_raw,minimum_buy_amount_raw,sell_decimals,buy_decimals,slippage_bps,price_impact_bps,estimated_fee_raw,approval_address,provider_tool,provider_snapshot,request_hash,expires_at) VALUES(?,?,?,?,?,'lifi',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        input.userId,
        input.source.id,
        input.destination.id,
        input.marketId ?? null,
        input.integrator,
        input.source.networkId,
        input.destination.networkId,
        input.sellToken,
        input.buyToken,
        input.sellAmountRaw,
        input.quote.toAmount,
        input.quote.toAmountMin,
        input.sellDecimals,
        input.buyDecimals,
        input.slippageBps,
        input.quote.priceImpactBps,
        input.quote.estimatedFeeRaw,
        input.quote.approvalAddress,
        input.quote.tool,
        JSON.stringify(input.quote.snapshot),
        requestHash,
        expires,
      ],
    )
    return { id, expiresAt: expires }
  }
  async quote(userId: string, id: string): Promise<QuoteRecord | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT id,user_id AS userId,source_account_id AS sourceAccountId,destination_account_id AS destinationAccountId,source_network_id AS sourceNetworkId,destination_network_id AS destinationNetworkId,sell_token AS sellToken,buy_token AS buyToken,CAST(sell_amount_raw AS CHAR) AS sellAmountRaw,CAST(buy_amount_raw AS CHAR) AS buyAmountRaw,CAST(minimum_buy_amount_raw AS CHAR) AS minimumBuyAmountRaw,sell_decimals AS sellDecimals,buy_decimals AS buyDecimals,slippage_bps AS slippageBps,approval_address AS approvalAddress,provider_snapshot AS providerSnapshot,expires_at AS expiresAt,consumed_at AS consumedAt FROM swap_quotes WHERE id=? AND user_id=?`,
      [id, userId],
    )
    const row = rows[0]
    if (!row) return null
    return {
      ...(row as unknown as QuoteRecord),
      providerSnapshot:
        typeof row.providerSnapshot === 'string' ? JSON.parse(row.providerSnapshot) : row.providerSnapshot,
      expiresAt: new Date(row.expiresAt),
      consumedAt: row.consumedAt ? new Date(row.consumedAt) : null,
    }
  }
  async existingIntent(userId: string, key: string) {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT id,status,intent_type AS intentType,chain_family AS chainFamily,network_id AS networkId,unsigned_transaction AS unsignedTransaction,normalized_summary AS normalizedSummary,expires_at AS expiresAt FROM transaction_intents WHERE user_id=? AND idempotency_key=?`,
      [userId, key],
    )
    return rows[0] ?? null
  }
  async createIntent(input: {
    userId: string
    accountId: string
    quoteId: string
    key: string
    type: 'swap' | 'erc20_approval'
    family: string
    networkId: string
    unsigned: unknown
    summary: unknown
    validation: unknown
    simulation: unknown
    ttl: number
    status?: string
  }) {
    const id = randomUUID(),
      expires = new Date(Date.now() + input.ttl * 1000),
      hash = canonicalHash(input.unsigned)
    await this.pool.execute(
      `INSERT INTO transaction_intents(id,user_id,account_id,quote_id,idempotency_key,intent_type,chain_family,network_id,status,unsigned_transaction,normalized_summary,validation_result,simulation_result,payload_hash,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        input.userId,
        input.accountId,
        input.quoteId,
        input.key,
        input.type,
        input.family,
        input.networkId,
        input.status ?? 'awaiting_signature',
        JSON.stringify(input.unsigned),
        JSON.stringify(input.summary),
        JSON.stringify(input.validation),
        JSON.stringify(input.simulation),
        hash,
        expires,
      ],
    )
    return {
      id,
      status: input.status ?? 'awaiting_signature',
      intentType: input.type,
      chainFamily: input.family,
      networkId: input.networkId,
      unsignedTransaction: input.unsigned,
      normalizedSummary: input.summary,
      expiresAt: expires,
    }
  }
}
