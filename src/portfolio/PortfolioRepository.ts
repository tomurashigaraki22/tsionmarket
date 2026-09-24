import type { Pool, RowDataPacket } from 'mysql2/promise'
import { randomUUID } from 'node:crypto'
import { NETWORKS } from './networks.js'

export type Account = {
  id: string
  networkId: string
  address: string
  family: 'evm' | 'solana' | 'intertrain'
  ownershipStatus: 'unverified' | 'verified'
}
export class PortfolioRepository {
  constructor(private pool: Pool) {}
  async marketTokens(
    networkId: string,
  ): Promise<Array<{ address: string; symbol: string; decimals: number }>> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT base_token AS address,base_symbol AS symbol,decimals FROM spot_markets WHERE network_id=? AND active=TRUE UNION SELECT quote_token AS address,quote_symbol AS symbol,6 AS decimals FROM spot_markets WHERE network_id=? AND active=TRUE`,
      [networkId, networkId],
    )
    return rows as Array<{ address: string; symbol: string; decimals: number }>
  }
  async listAccounts(userId: string): Promise<Account[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT a.id,a.network_id AS networkId,a.address,n.family,a.ownership_status AS ownershipStatus FROM wallet_accounts a JOIN networks n ON n.network_id=a.network_id WHERE a.user_id=? AND a.status='active' AND n.enabled=TRUE ORDER BY n.sort_order,a.created_at`,
      [userId],
    )
    return rows as Account[]
  }
  async addAccount(userId: string, networkId: string, address: string, label?: string): Promise<string> {
    const id = randomUUID()
    await this.pool.execute(
      `INSERT INTO wallet_accounts(id,user_id,network_id,address,label) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE label=VALUES(label),status='active'`,
      [id, userId, networkId, address, label ?? null],
    )
    return id
  }
  async listNetworks() {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT network_id AS networkId,family,name,environment,chain_id AS chainId,cluster,native_symbol AS nativeSymbol,native_decimals AS nativeDecimals,capabilities FROM networks WHERE enabled=TRUE ORDER BY sort_order`,
    )
    return rows.map((row) => {
      const configured = NETWORKS.find((network) => network.networkId === row.networkId)
      const stored = (row.capabilities ?? {}) as Record<string, unknown>
      return {
        ...row,
        capabilities: {
          enabled: true,
          balanceReads: stored.balance === true,
          quotes: stored.quotes !== false,
          intents: stored.intents !== false,
          submission: stored.submission !== false,
          sponsorship: false,
        },
        explorer: configured?.explorer ?? null,
      }
    })
  }
  async applyNetworkMode(mode: 'development' | 'testnet' | 'mainnet') {
    const environments =
      mode === 'mainnet' ? ['mainnet'] : mode === 'testnet' ? ['testnet'] : ['testnet', 'devnet']
    await this.pool.query(`UPDATE networks SET enabled = environment IN (?)`, [environments])
  }
}
