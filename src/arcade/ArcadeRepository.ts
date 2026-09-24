/* eslint-disable @typescript-eslint/no-unsafe-return -- mysql2 RowDataPacket values cross a runtime database boundary */
import type { Pool, RowDataPacket } from 'mysql2/promise'

export type ArcadeGame = {
  id: string
  name: string
  tagline: string
  category: 'skill' | 'cards' | 'draws'
  status: 'live' | 'coming_soon'
  coverUrl: string | null
  stakeAsset: string | null
  stakeNetworkId: string | null
}

export class ArcadeRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * The catalogue.
   *
   * Disabled games are withheld rather than returned with a flag: a client
   * that forgets to filter should show nothing, not a game that was pulled.
   *
   * Player counts are deliberately absent. The mock this replaces invented
   * them, and there is no round table to count until phase 4 — the same rule
   * the market listings follow for a missing 24h change.
   */
  async listGames(): Promise<Array<ArcadeGame>> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT id, name, tagline, category, status,
        cover_url AS coverUrl, stake_asset AS stakeAsset,
        stake_network_id AS stakeNetworkId
       FROM arcade_games
       WHERE status <> 'disabled'
       ORDER BY sort_order ASC, id ASC`,
    )
    return rows as Array<ArcadeGame>
  }
}
