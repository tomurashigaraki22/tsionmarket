import { randomUUID } from 'node:crypto'
import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { BalanceService } from './BalanceService.js'
import { Decimal } from 'decimal.js'
import { fromMysqlDateTime } from '../db/datetime.js'

// asOf is a string, not a Date: the pool runs with dateStrings: true.
type Price = { networkId: string; token: string; symbol: string; priceUsd: string; asOf: string }
const nativeToken: Record<string, string> = {
  'ethereum-mainnet': '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  'arbitrum-one': '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  'solana-mainnet-beta': 'So11111111111111111111111111111111111111112',
}
const key = (network: string, token: string) =>
  `${network}:${network.startsWith('solana') ? token : token.toLowerCase()}`
export class ValuationService {
  constructor(
    private pool: Pool,
    private balances: BalanceService,
  ) {}
  async current(userId: string, persist = true) {
    const snapshot = await this.balances.portfolio(userId),
      prices = await this.prices(),
      byToken = new Map(prices.map((price) => [key(price.networkId, price.token), price])),
      positions: Record<string, unknown>[] = [],
      values: Decimal[] = []
    let unpriced = 0
    for (const account of snapshot.accounts)
      for (const asset of account.assets) {
        const token = asset.assetId === 'native' ? nativeToken[account.networkId] : asset.assetId,
          price = token ? byToken.get(key(account.networkId, token)) : undefined
        if (!price) {
          unpriced++
          positions.push({
            accountId: account.accountId,
            networkId: account.networkId,
            assetId: asset.assetId,
            symbol: asset.symbol,
            raw: asset.raw,
            decimals: asset.decimals,
            priceUsd: null,
            valueUsd: null,
            priceAsOf: null,
          })
          continue
        }
        const value = new Decimal(asset.raw).div(new Decimal(10).pow(asset.decimals)).mul(price.priceUsd)
        values.push(value)
        positions.push({
          accountId: account.accountId,
          networkId: account.networkId,
          assetId: asset.assetId,
          symbol: asset.symbol,
          raw: asset.raw,
          decimals: asset.decimals,
          priceUsd: price.priceUsd,
          valueUsd: value.toFixed(8),
          priceAsOf: fromMysqlDateTime(price.asOf).toISOString(),
          provenance: 'spot_market_registry',
        })
      }
    const total = values.reduce((sum, value) => sum.add(value), new Decimal(0)).toFixed(8),
      priceAsOf = prices.length
        ? new Date(Math.min(...prices.map((price) => fromMysqlDateTime(price.asOf).getTime())))
        : null,
      result = {
        currency: 'USD' as const,
        decimalPrecision: 8,
        asOf: new Date().toISOString(),
        priceAsOf: priceAsOf?.toISOString() ?? null,
        totalValueUsd: total,
        pricedValueUsd: total,
        unpricedAssetCount: unpriced,
        stale: snapshot.stale,
        status:
          snapshot.accounts.length > 0 &&
          snapshot.accounts.every((account) => account.state === 'unavailable')
            ? ('unavailable' as const)
            : snapshot.errors > 0 || unpriced > 0
              ? ('partial' as const)
              : values.length === 0
                ? ('zero' as const)
                : ('complete' as const),
        positions,
        pnl: {
          available: false,
          reason:
            'Realized and cost-basis P&L requires verified fill amounts; quote estimates are not used as fills.',
        },
      }
    if (persist)
      await this.pool.execute(
        `INSERT INTO portfolio_valuation_snapshots(id,user_id,total_value_usd,priced_value_usd,unpriced_asset_count,stale,price_as_of,positions) VALUES(?,?,?,?,?,?,?,?)`,
        [randomUUID(), userId, total, total, unpriced, snapshot.stale, priceAsOf, JSON.stringify(positions)],
      )
    return result
  }
  async history(userId: string, limit: number) {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT id,CAST(total_value_usd AS CHAR) AS totalValueUsd,CAST(priced_value_usd AS CHAR) AS pricedValueUsd,unpriced_asset_count AS unpricedAssetCount,stale,price_as_of AS priceAsOf,created_at AS createdAt FROM portfolio_valuation_snapshots WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT ?`,
      [userId, limit],
    )
    return rows
  }
  private async prices(): Promise<Price[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT network_id AS networkId,base_token AS token,base_symbol AS symbol,CAST(price_usd AS CHAR) AS priceUsd,synced_at AS asOf FROM spot_markets WHERE active=TRUE AND price_usd IS NOT NULL UNION ALL SELECT network_id,quote_token,quote_symbol,'1.00000000',MAX(synced_at) FROM spot_markets WHERE active=TRUE AND quote_symbol IN ('USDC','USDT') GROUP BY network_id,quote_token,quote_symbol`,
    )
    return rows as Price[]
  }
}
