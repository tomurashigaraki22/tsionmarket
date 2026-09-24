import { logger } from '../utils/logger.js'
import type { RoundRepository } from './RoundRepository.js'

const BATCH = 50

/**
 * Drives rounds forward on a timer.
 *
 * The server owns the clock, so nothing advances because a client said the
 * deadline passed — this sweep is the only thing that resolves a tick. It runs
 * often relative to the tick length, because a round that stalls past its
 * deadline is a round where everyone is staring at a dead timer.
 *
 * Each round advances in its own transaction under a row lock, so two
 * instances running this sweep resolve each tick once between them rather
 * than twice.
 */
export class ArcadeWorker {
  private timer?: NodeJS.Timeout
  private running = false

  constructor(
    private readonly rounds: RoundRepository,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.sweep(), this.intervalMs)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  async sweep(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const due = await this.rounds.dueRounds(BATCH)
      for (const round of due) {
        try {
          await this.rounds.advance(round.id)
        } catch (error) {
          // One bad round must not stall every other round in the sweep.
          logger.error('Arcade round could not be advanced', { roundId: round.id, error })
        }
      }
    } catch (error) {
      logger.error('Arcade sweep failed', { error })
    } finally {
      this.running = false
    }
  }
}
