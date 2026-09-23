# TsionMarket Backend

Phase 0 product/security contracts, the Phase 1 service foundation, and Phase 2 first-party authentication for TsionMarket.

## Architecture boundaries

- Crypto spot markets, not prediction markets or a custodial exchange.
- Wallet provisioning, secret storage/recovery, unlocking, and signing are frontend-only.
- First-party email/password authentication uses Argon2id, short-lived access tokens, rotating opaque refresh sessions, email verification, and password recovery.
- MySQL 8.x is the only database.
- Application persistence uses direct parameterized SQL through `mysql2/promise`; no ORM or query builder.

## Prerequisites

- Node.js 22+
- Docker Desktop with Compose

## Local setup

```powershell
Copy-Item .env.example .env
npm install
docker compose up -d mysql
npm run db:migrate
npm run db:verify
npm run dev
```

Check the service:

```powershell
Invoke-RestMethod http://localhost:3030/health
Invoke-RestMethod http://localhost:3030/ready
```

To run the complete container stack instead:

```powershell
docker compose --profile app up --build
```

The Compose passwords are development defaults. Replace all credentials outside local development. Production uses a least-privileged application user and separate migration credentials.

## Verification

```powershell
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run audit:production
docker build -t tsionmarket-backend .
```

## Authentication endpoints

```text
POST   /v1/auth/register
POST   /v1/auth/verify-email
POST   /v1/auth/resend-verification
POST   /v1/auth/login
POST   /v1/auth/refresh
POST   /v1/auth/logout
POST   /v1/auth/logout-all
GET    /v1/auth/sessions
DELETE /v1/auth/sessions/:sessionId
POST   /v1/auth/change-password
POST   /v1/auth/forgot-password
POST   /v1/auth/reset-password
GET    /v1/auth/me
```

In local development, registration/recovery responses include a `developmentChallengeToken`; staging and production never return it. Refresh requires the refresh cookie, the CSRF cookie value in `x-csrf-token`, and an allowed `Origin`.

## Documentation

- [Implementation plan](BACKEND_IMPLEMENTATION_PLAN.md)
- [Product contract](docs/product-contract.md)
- [API contract](docs/api-contract.md)
- [Threat model](docs/threat-model.md)
- [Reference inventory](docs/reference-inventory.md)
- [Service targets](docs/service-level-objectives.md)
- [MySQL migration runbook](docs/runbooks/mysql-migrations.md)
- [Phase 2 status](docs/phase-2-status.md)
