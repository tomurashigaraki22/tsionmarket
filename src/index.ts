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
import { ArcadeRepository } from './arcade/ArcadeRepository.js'
import { RoundRepository } from './arcade/RoundRepository.js'
import { ArcadeWorker } from './arcade/ArcadeWorker.js'
import { ArcadeLimits } from './arcade/ArcadeLimits.js'
import { DepositWatcher } from './arcade/DepositWatcher.js'
import { DepositIntentService } from './arcade/DepositIntentService.js'
import { ChessRepository } from './arcade/ChessRepository.js'
import { SettingsRepository } from './settings/SettingsRepository.js'
import { WithdrawalIntentService } from './trading/WithdrawalIntentService.js'
import { ChessWorker } from './arcade/ChessWorker.js'
import { ProfileRepository } from './social/ProfileRepository.js'
import { FloorRepository } from './social/FloorRepository.js'
import { FloorService } from './social/FloorService.js'
import { OwnershipRepository } from './portfolio/OwnershipRepository.js'
import { OwnershipService } from './portfolio/OwnershipService.js'
import { getOnSwitchRuntimeConfig } from './config/onswitch.js'
import { OnSwitchClient } from './payments/onswitch/client.js'
import { OnSwitchPaymentRepository } from './payments/onswitch/repository.js'
import { OnSwitchCatalogueService } from './payments/onswitch/catalogue.js'
import { OnSwitchWebhookService } from './payments/onswitch/webhook.js'
import { OnSwitchWorker } from './payments/onswitch/worker.js'
import { OnSwitchPaymentsService } from './payments/onswitch/service.js'
import { OnSwitchPaymentFlowService } from './payments/onswitch/journeys.js'

const environment = getEnvironment()
const pool = createApplicationPool(environment)
const authRepository = new AuthRepository(pool, environment.MYSQL_ACQUIRE_TIMEOUT_MS)
const authService = new AuthService(authRepository, createEmailService(environment), environment)
const authCleanupWorker = new AuthCleanupWorker(pool, environment.AUTH_CLEANUP_INTERVAL_SECONDS)
const portfolioRepository = new PortfolioRepository(pool)
const ownershipService = new OwnershipService(new OwnershipRepository(pool))
const rpcManager = new RpcManager(environment)
const balanceService = new BalanceService(portfolioRepository, rpcManager, environment)
const marketRepository = new MarketRepository(pool)
const marketRegistryWorker = new MarketRegistryWorker(marketRepository, environment)
const tradingRepository = new TradingRepository(pool)
const quoteService = new QuoteService(tradingRepository, new LifiProvider(environment), environment)
const intentService = new IntentService(tradingRepository, rpcManager, environment)
const withdrawalIntentService = new WithdrawalIntentService(tradingRepository, rpcManager, environment)
const transactionRepository = new TransactionRepository(pool)
const transactionService = new TransactionService(transactionRepository, rpcManager, environment)
const reconciliationWorker = new ReconciliationWorker(transactionRepository, rpcManager, environment)
const valuationService = new ValuationService(pool, balanceService)
const arcadeRepository = new ArcadeRepository(pool)
const roundRepository = new RoundRepository(
  pool,
  environment.ARCADE_DEPOSIT_ADDRESS ?? null,
  environment.ARCADE_DEPOSIT_FEE_BPS,
)
const arcadeWorker = new ArcadeWorker(roundRepository, 2000)
const arcadeLimits = new ArcadeLimits(pool)
const depositWatcher = new DepositWatcher(pool, rpcManager, environment)
const depositIntents = new DepositIntentService(pool, rpcManager, environment)
const chessRepository = new ChessRepository(pool)
const settingsRepository = new SettingsRepository(pool)
const chessWorker = new ChessWorker(chessRepository)
const profileRepository = new ProfileRepository(pool)
const floorService = new FloorService(new FloorRepository(pool), profileRepository, pool)
const onSwitchConfig = getOnSwitchRuntimeConfig(environment)
const onSwitchClient = onSwitchConfig ? new OnSwitchClient(onSwitchConfig) : null
const onSwitchPaymentRepository = new OnSwitchPaymentRepository(
  pool,
  environment.ONSWITCH_DATA_ENCRYPTION_KEY,
  environment.ONSWITCH_MAX_ACTIVE_OPERATIONS_PER_USER,
)
const onSwitchCatalogue = new OnSwitchCatalogueService(onSwitchClient, onSwitchPaymentRepository, environment)
const onSwitchPayments = new OnSwitchPaymentsService(onSwitchPaymentRepository, environment)
const onSwitchPaymentFlows = new OnSwitchPaymentFlowService(
  onSwitchClient,
  onSwitchCatalogue,
  onSwitchPaymentRepository,
  onSwitchPayments,
  tradingRepository,
  withdrawalIntentService,
  environment,
)
const onSwitchWebhook = new OnSwitchWebhookService(onSwitchConfig, onSwitchPaymentRepository)
const onSwitchWorker = onSwitchClient
  ? new OnSwitchWorker(onSwitchPaymentRepository, onSwitchClient, environment)
  : null
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
  ownershipService,
  profileRepository,
  floorService,
  arcadeRepository,
  roundRepository,
  arcadeLimits,
  depositIntents,
  chessRepository,
  settingsRepository,
  withdrawalIntentService,
  onSwitchPaymentRepository,
  onSwitchCatalogue,
  onSwitchPaymentFlows,
  onSwitchWebhook,
})
const server = createServer(app)

server.listen(environment.PORT, environment.HOST, () => {
  authCleanupWorker.start()
  marketRegistryWorker.start()
  reconciliationWorker.start()
  arcadeWorker.start()
  chessWorker.start()
  depositWatcher.start()
  onSwitchWorker?.start()
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
      arcadeWorker.stop()
      chessWorker.stop()
      depositWatcher.stop()
      onSwitchWorker?.stop()
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
