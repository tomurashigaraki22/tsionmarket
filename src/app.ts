import express, { type Express } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import cookieParser from 'cookie-parser'
import type { Environment } from './config/env.js'
import { requestId } from './api/middleware/requestId.js'
import { errorHandler, notFound } from './api/middleware/errorHandler.js'
import { healthRouter } from './api/routes/health.js'
import type { ReadinessCheck } from './services/readiness.js'
import { AppError } from './utils/errors.js'
import type { AuthService } from './auth/AuthService.js'
import { authRouter } from './api/routes/auth.js'
import { authenticationMiddleware } from './auth/middleware.js'
import type { PortfolioRepository } from './portfolio/PortfolioRepository.js'
import type { BalanceService } from './portfolio/BalanceService.js'
import type { MarketRepository } from './markets/MarketRepository.js'
import { ChartService } from './markets/ChartService.js'
import { portfolioRouter } from './api/routes/portfolio.js'
import { marketsRouter } from './api/routes/markets.js'
import type { QuoteService } from './trading/QuoteService.js'
import type { IntentService } from './trading/IntentService.js'
import { tradingRouter } from './api/routes/trading.js'
import type { TransactionService } from './transactions/TransactionService.js'
import type { TransactionRepository } from './transactions/TransactionRepository.js'
import { transactionsRouter } from './api/routes/transactions.js'
import { metricsHandler, metricsMiddleware } from './observability/metrics.js'
import type { ValuationService } from './portfolio/ValuationService.js'
import { phase12Router } from './api/routes/phase12.js'
import type { OwnershipService } from './portfolio/OwnershipService.js'
import type { ProfileRepository } from './social/ProfileRepository.js'
import type { FloorService } from './social/FloorService.js'
import { socialRouter } from './api/routes/social.js'

export type AppDependencies = {
  environment: Environment
  readinessCheck: ReadinessCheck
  authService?: AuthService
  portfolioRepository?: PortfolioRepository
  balanceService?: BalanceService
  marketRepository?: MarketRepository
  quoteService?: QuoteService
  intentService?: IntentService
  transactionService?: TransactionService
  transactionRepository?: TransactionRepository
  valuationService?: ValuationService
  ownershipService?: OwnershipService
  profileRepository?: ProfileRepository
  floorService?: FloorService
}

export function createApp({
  environment,
  readinessCheck,
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
}: AppDependencies): Express {
  const app = express()
  app.disable('x-powered-by')
  if (environment.TRUST_PROXY_HOPS > 0) app.set('trust proxy', environment.TRUST_PROXY_HOPS)

  app.use(requestId)
  app.use(metricsMiddleware())
  app.use(helmet())
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || environment.CORS_ALLOWED_ORIGINS.includes(origin)) callback(null, true)
        else callback(new AppError('CORS_ORIGIN_DENIED', 'Origin is not allowed', 403))
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-request-id', 'x-csrf-token'],
      exposedHeaders: ['x-request-id'],
      maxAge: 600,
    }),
  )
  app.use(cookieParser())
  app.use(express.json({ limit: environment.JSON_BODY_LIMIT, strict: true }))
  app.use(
    rateLimit({
      windowMs: environment.RATE_LIMIT_WINDOW_MS,
      limit: environment.RATE_LIMIT_MAX,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      skip: (request) => request.path === '/health' || request.path === '/ready',
      handler: (request, response) =>
        response.status(429).json({
          success: false,
          error: { code: 'RATE_LIMITED', message: 'Too many requests' },
          requestId: request.requestId,
        }),
    }),
  )

  app.use(healthRouter(readinessCheck))
  app.get('/metrics', metricsHandler(environment))
  // The normalized, read-only catalogue powers the public landing page. All
  // execution endpoints remain behind the authenticated boundary below.
  if (marketRepository)
    app.use(
      '/v1',
      marketsRouter(
        marketRepository,
        environment.MARKET_STALE_AFTER_SECONDS,
        new ChartService(environment),
      ),
    )
  if (authService) {
    app.use('/v1/auth', authRouter(authService, environment))
    // Future /v1 routers inherit a fail-closed authenticated boundary unless
    // they are deliberately mounted above this line as public routes.
    app.use('/v1', authenticationMiddleware(authService))
    if (portfolioRepository && balanceService && ownershipService)
      app.use('/v1', portfolioRouter(portfolioRepository, balanceService, ownershipService))
    if (quoteService && intentService && transactionRepository)
      app.use('/v1', tradingRouter(quoteService, intentService, transactionRepository))
    if (transactionService && transactionRepository)
      app.use('/v1', transactionsRouter(transactionService, transactionRepository))
    if (valuationService && transactionRepository)
      app.use('/v1', phase12Router(valuationService, transactionRepository))
    if (profileRepository && floorService)
      app.use('/v1', socialRouter(profileRepository, floorService))
  }
  app.use(notFound)
  app.use(errorHandler)
  return app
}
