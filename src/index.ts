import 'dotenv/config'
import { createServer } from 'node:http'
import { createApp } from './app.js'
import { getEnvironment } from './config/env.js'
import { createApplicationPool } from './db/pool.js'
import { createReadinessCheck } from './services/readiness.js'
import { logger } from './utils/logger.js'
import { AuthRepository } from './auth/AuthRepository.js'
import { AuthService } from './auth/AuthService.js'
import { createEmailService } from './auth/EmailService.js'
import { AuthCleanupWorker } from './auth/AuthCleanupWorker.js'
import { PortfolioRepository } from './portfolio/PortfolioRepository.js'
import { RpcManager } from './portfolio/RpcManager.js'
import { BalanceService } from './portfolio/BalanceService.js'
import { MarketRepository } from './markets/MarketRepository.js'
import { MarketRegistryWorker } from './markets/MarketRegistryWorker.js'
import { TradingRepository } from './trading/TradingRepository.js'
import { LifiProvider } from './trading/LifiProvider.js'
import { QuoteService } from './trading/QuoteService.js'
import { IntentService } from './trading/IntentService.js'
import { TransactionRepository } from './transactions/TransactionRepository.js'
import { TransactionService } from './transactions/TransactionService.js'
import { ReconciliationWorker } from './transactions/ReconciliationWorker.js'
import { ValuationService } from './portfolio/ValuationService.js'

const environment = getEnvironment()
const pool = createApplicationPool(environment)
const authRepository = new AuthRepository(pool, environment.MYSQL_ACQUIRE_TIMEOUT_MS)
const authService = new AuthService(authRepository, createEmailService(environment), environment)
const authCleanupWorker = new AuthCleanupWorker(pool, environment.AUTH_CLEANUP_INTERVAL_SECONDS)
const portfolioRepository = new PortfolioRepository(pool)
const rpcManager = new RpcManager(environment)
const balanceService = new BalanceService(portfolioRepository, rpcManager, environment)
const marketRepository = new MarketRepository(pool)
const marketRegistryWorker = new MarketRegistryWorker(marketRepository, environment)
const tradingRepository = new TradingRepository(pool)
const quoteService = new QuoteService(tradingRepository, new LifiProvider(environment), environment)
const intentService = new IntentService(tradingRepository, rpcManager, environment)
const transactionRepository = new TransactionRepository(pool)
const transactionService = new TransactionService(transactionRepository, rpcManager, environment)
const reconciliationWorker = new ReconciliationWorker(transactionRepository, rpcManager, environment)
const valuationService = new ValuationService(pool, balanceService)
await portfolioRepository.applyNetworkMode(environment.NETWORK_MODE)
const app = createApp({
  environment,
  readinessCheck: createReadinessCheck(pool),
  authService,
  portfolioRepository,
  balanceService,
  marketRepository,
  quoteService,
  intentService,
  transactionService,
  transactionRepository,
  valuationService,
})
const server = createServer(app)

server.listen(environment.PORT, environment.HOST, () => {
  authCleanupWorker.start()
  marketRegistryWorker.start()
  reconciliationWorker.start()
  logger.info('HTTP server started', { host: environment.HOST, port: environment.PORT })
})

let shuttingDown = false
function shutdown(signal: string): void {
  if (shuttingDown) return
  shuttingDown = true
  logger.info('Graceful shutdown started', { signal })

  const forceTimer = setTimeout(() => {
    logger.error('Graceful shutdown timed out')
    process.exit(1)
  }, 15_000)
  forceTimer.unref()

  server.close(async (error) => {
    try {
      authCleanupWorker.stop()
      marketRegistryWorker.stop()
      reconciliationWorker.stop()
      await pool.end()
      if (error) throw error
      clearTimeout(forceTimer)
      logger.info('Graceful shutdown complete')
      process.exit(0)
    } catch (shutdownError) {
      logger.error('Graceful shutdown failed', { error: shutdownError })
      process.exit(1)
    }
  })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error })
  shutdown('uncaughtException')
})
process.on('unhandledRejection', (error) => {
  logger.error('Unhandled rejection', { error })
  shutdown('unhandledRejection')
})
