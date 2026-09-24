/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment -- mysql2 RowDataPacket values cross a runtime database boundary */
import type { Pool, RowDataPacket } from 'mysql2/promise'

export type MarketInput = {
  marketId: string
  venue: string
  marketCategory: 'market' | 'meme'
  networkId: string
  baseSymbol: string
  quoteSymbol: string
  baseToken: string
  quoteToken: string
  decimals: number
  priceUsd: number | null
  liquidityUsd: number | null
  volume24hUsd: number | null
  iconUrl: string | null
  chartSymbol: string | null
}
export type MarketQuery = {
  networkId?: string | undefined
  venue?: string | undefined
  marketCategory?: 'meme' | undefined
  search?: string | undefined
  limit: number
  cursor?: string | undefined
}
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
function decode(value?: string): { liquidity: string; id: string } | undefined {
  if (!value) return
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString())
  } catch {
    return
  }
}

export class MarketRepository {
  constructor(private pool: Pool) {}
  async replaceRoute(
    routeId: string,
    networkId: string,
    venue: string,
    markets: MarketInput[],
  ): Promise<void> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      // Only deactivate after a provider response has been validated, and do
      // it inside the same transaction as replacement so an interrupted sync
      // cannot empty the catalogue.
      await connection.execute(`UPDATE spot_markets SET active=FALSE WHERE network_id=? AND venue=?`, [
        networkId,
        venue,
      ])
      for (const m of markets)
        await connection.execute(
          `INSERT INTO spot_markets(market_id,venue,market_category,network_id,base_symbol,quote_symbol,base_token,quote_token,decimals,price_usd,liquidity_usd,volume_24h_usd,icon_url,chart_symbol,last_seen_at,synced_at,active) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(6),NOW(6),TRUE) ON DUPLICATE KEY UPDATE market_category=VALUES(market_category),base_symbol=VALUES(base_symbol),decimals=VALUES(decimals),price_usd=VALUES(price_usd),liquidity_usd=VALUES(liquidity_usd),volume_24h_usd=VALUES(volume_24h_usd),icon_url=VALUES(icon_url),chart_symbol=VALUES(chart_symbol),last_seen_at=NOW(6),synced_at=NOW(6),active=TRUE`,
          [
            m.marketId,
            m.venue,
            m.marketCategory,
            m.networkId,
            m.baseSymbol,
            m.quoteSymbol,
            m.baseToken,
            m.quoteToken,
            m.decimals,
            m.priceUsd,
            m.liquidityUsd,
            m.volume24hUsd,
            m.iconUrl,
            m.chartSymbol,
          ],
        )
      await connection.execute(
        `INSERT INTO market_registry_status(route_id,last_attempt_at,last_success_at,last_error,market_count) VALUES(?,NOW(6),NOW(6),NULL,?) ON DUPLICATE KEY UPDATE last_attempt_at=NOW(6),last_success_at=NOW(6),last_error=NULL,market_count=VALUES(market_count)`,
        [routeId, markets.length],
      )
      await connection.commit()
    } catch (e) {
      await connection.rollback()
      throw e
    } finally {
      connection.release()
    }
  }
  async failed(routeId: string, message: string) {
    await this.pool.execute(
      `INSERT INTO market_registry_status(route_id,last_attempt_at,last_error) VALUES(?,NOW(6),?) ON DUPLICATE KEY UPDATE last_attempt_at=NOW(6),last_error=VALUES(last_error)`,
      [routeId, message.slice(0, 500)],
    )
  }
  async browse(q: MarketQuery, staleAfter: number) {
    const cursor = decode(q.cursor)
    const where = [`m.active=TRUE`, `m.price_usd IS NOT NULL`],
      params: Array<string | number> = []
    if (q.networkId) {
      where.push(`m.network_id=?`)
      params.push(q.networkId)
    }
    if (q.venue) {
      where.push(`m.venue=?`)
      params.push(q.venue)
    }
    if (q.marketCategory === 'meme') {
      // Memecoins are an explicit Jupiter/Solana catalogue category. Keep the
      // network guard here as well as in the request contract so this cannot
      // accidentally become a cross-chain filter if another provider adds a
      // similarly named category later.
      where.push(`m.market_category=?`, `m.network_id=?`, `m.venue=?`)
      params.push('meme', 'solana-mainnet-beta', 'jupiter')
    }
    if (q.search) {
      where.push(`(m.base_symbol LIKE ? OR m.quote_symbol LIKE ?)`)
      // The symbol columns are ascii_bin, so LIKE compares case-sensitively.
      // Upper-casing the needle rather than the column keeps idx_markets_search
      // usable; MarketRegistryWorker upper-cases every symbol before it is
      // stored, so the stored side is already normalised.
      const s = `%${q.search.toUpperCase().replace(/[\\%_]/g, '\\$&')}%`
      params.push(s, s)
    }
    if (cursor) {
      where.push(`(COALESCE(m.liquidity_usd,0) < ? OR (COALESCE(m.liquidity_usd,0)=? AND m.market_id>?))`)
      params.push(cursor.liquidity, cursor.liquidity, cursor.id)
    }
    params.push(q.limit + 1)
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT m.market_id AS marketId,m.venue,m.market_category AS marketCategory,m.network_id AS networkId,m.base_symbol AS baseSymbol,m.quote_symbol AS quoteSymbol,m.base_token AS baseToken,m.quote_token AS quoteToken,m.decimals,m.decimals AS baseDecimals,6 AS quoteDecimals,TRUE AS executable,'active' AS status,CAST(m.price_usd AS CHAR) AS priceUsd,CAST(m.liquidity_usd AS CHAR) AS liquidityUsd,CAST(m.volume_24h_usd AS CHAR) AS volume24hUsd,m.icon_url AS iconUrl,m.chart_symbol AS chartSymbol,m.synced_at AS syncedAt,m.synced_at AS observedAt FROM spot_markets m JOIN networks n ON n.network_id=m.network_id AND n.enabled=TRUE WHERE ${where.join(' AND ')} ORDER BY COALESCE(m.liquidity_usd,0) DESC,m.market_id ASC LIMIT ?`,
      params,
    )
    const hasMore = rows.length > q.limit,
      items = rows.slice(0, q.limit),
      last = items.at(-1)
    const [status] = await this.pool.execute<RowDataPacket[]>(
      `SELECT MAX(last_success_at) AS lastSuccessAt FROM market_registry_status`,
    )
    const lastSuccess = status[0]?.lastSuccessAt ? new Date(status[0].lastSuccessAt) : null
    return {
      items,
      nextCursor:
        hasMore && last ? encode({ liquidity: String(last.liquidityUsd ?? '0'), id: last.marketId }) : null,
      stale: !lastSuccess || Date.now() - lastSuccess.getTime() > staleAfter * 1000,
      lastSuccessfulSync: lastSuccess?.toISOString() ?? null,
    }
  }
}
