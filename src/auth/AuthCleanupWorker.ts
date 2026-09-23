import type { Pool, ResultSetHeader } from 'mysql2/promise'
import { logger } from '../utils/logger.js'

export class AuthCleanupWorker {
  private timer: NodeJS.Timeout | undefined
  private running = false

  constructor(
    private readonly pool: Pool,
    private readonly intervalSeconds: number,
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.run(), this.intervalSeconds * 1000)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  async run(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const [challenges] = await this.pool.execute<ResultSetHeader>(
        `DELETE FROM auth_challenges
         WHERE expires_at < TIMESTAMPADD(DAY, -1, CURRENT_TIMESTAMP(6))
            OR consumed_at < TIMESTAMPADD(DAY, -1, CURRENT_TIMESTAMP(6))
         LIMIT 500`,
      )
      const [sessions] = await this.pool.execute<ResultSetHeader>(
        `DELETE FROM auth_sessions
         WHERE absolute_expires_at < TIMESTAMPADD(DAY, -30, CURRENT_TIMESTAMP(6))
            OR revoked_at < TIMESTAMPADD(DAY, -30, CURRENT_TIMESTAMP(6))
         LIMIT 500`,
      )
      logger.info('Authentication cleanup completed', {
        deletedChallenges: challenges.affectedRows,
        deletedSessions: sessions.affectedRows,
      })
    } catch (error) {
      logger.error('Authentication cleanup failed', { error })
    } finally {
      this.running = false
    }
  }
}
