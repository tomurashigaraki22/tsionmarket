import { logger } from '../utils/logger.js'
import type { ChessRepository } from './ChessRepository.js'

export class ChessWorker {
  private timer?: NodeJS.Timeout
  private running = false

  constructor(
    private readonly chess: ChessRepository,
    private readonly intervalMs = 5_000,
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
      await this.chess.sweep()
    } catch (error) {
      logger.error('Chess deadline sweep failed', { error })
    } finally {
      this.running = false
    }
  }
}
