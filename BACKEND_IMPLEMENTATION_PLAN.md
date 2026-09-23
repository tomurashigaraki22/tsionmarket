# TsionMarket Backend — Comprehensive Phased Implementation Plan

**Status:** Implementation-ready draft  
**Target repository:** `tsionmarket`  
**Reference implementation:** `worldstreet-crypto-backend`  
**Primary scope:** Authentication, wallet ownership, balance checking, markets, quotes, transaction intents, execution tracking, security, and production rollout

---

## 1. Objective

Build the TsionMarket backend using the proven architectural and security patterns already present in `worldstreet-crypto-backend`, while keeping TsionMarket as an independent service with its own configuration, database, deployment, API contract, and product-specific market rules.

The target request flow is:

```text
TsionMarket client
       |
       v
First-party TsionMarket authentication
       |
       v
Internal user and wallet ownership resolution
       |
       +--------------------+
       |                    |
       v                    v
Market catalogue       Wallet balances
and live quotes         and spendability checks
       |                    |
       +---------+----------+
                 |
                 v
       Reviewed transaction intent
                 |
                 v
       Client-side user signature
                 |
                 v
       Backend validation and submission
                 |
                 v
       Reconciliation, history, and audit
```

### Success definition

TsionMarket is complete when an authenticated user can:

1. Create/provision their wallet entirely on the frontend, then register only its public account/address metadata with the backend.
2. Read balances across enabled networks.
3. Browse and search an accurate market catalogue.
4. Request an executable quote.
5. Receive a clear insufficient-balance or fee-balance error before signing.
6. Review and sign an exact transaction locally.
7. Submit the signed payload without the backend changing the reviewed transaction.
8. Follow the transaction through submitted, confirmed, failed, expired, or unknown states.
9. Retrieve complete market and transaction history without accessing another user's data.

---

## 2. Current-state assessment

At the time this plan was written, the `tsionmarket` repository has no application source, package manifest, or established backend structure. It should therefore be treated as a greenfield backend, not as a migration of existing TsionMarket code.

The reference backend currently provides reusable patterns for:

- TypeScript, Express, Zod, Vitest, structured logging, and patterns that can be adapted to direct MySQL access.
- A normalized user identity and ownership boundary, adapted to TsionMarket's first-party authentication system.
- User-owned wallet, account, address, network, intent, and transaction models.
- Chain-adapter-based balance reads.
- Bounded balance concurrency, timeout, stale-cache fallback, and request coalescing.
- Spot-market registry, market ranking, quotes, approvals, and locally signable intents.
- Idempotent intent creation, simulation, signed-payload binding, submission, and reconciliation.
- Health/readiness endpoints, emergency pause controls, mainnet gates, and runbooks.

### Reuse policy

Reuse concepts and reviewed modules deliberately; do not blindly copy the entire Worldstreet service.

- Preserve the authentication, ownership, intent, signing, and audit invariants.
- Extract or port only the chain adapters and market providers TsionMarket actually needs.
- Give TsionMarket its own containerized MySQL service, SQL schema/migrations, authentication secrets, CORS origins, rate limits, provider credentials, deployment flags, and operational controls.
- Use SQL directly through a small pooled MySQL driver. Do not introduce an ORM, active-record layer, schema mapper, or ORM migration tool.
- Keep wallet key generation, recovery material, encrypted key packaging, wallet provisioning, unlocking, and transaction signing on the frontend.
- Do not share mutable production schemas or tables with Worldstreet.
- Do not expose provider keys, private keys, seed phrases, wallet DEKs, or unrestricted signing endpoints.
- Do not make the market API depend directly on a provider response shape; normalize at the provider boundary.

---

## 3. Decisions to lock before implementation

These decisions are Phase 0 deliverables. Defaults are proposed so development can begin without blocking.

| Decision                | Proposed default                                                                                            | Why it matters                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Runtime                 | Node.js LTS + TypeScript ESM                                                                                | Matches the reference backend                                                         |
| HTTP framework          | Express                                                                                                     | Lowest-risk parity path                                                               |
| Database                | MySQL 8.x in Docker with a persistent named volume                                                          | Relational constraints, transactions, direct SQL, and repeatable local infrastructure |
| Data access             | Direct parameterized SQL through `mysql2/promise`                                                           | No ORM; queries and transaction boundaries remain explicit and reviewable             |
| User authentication     | First-party email/password authentication with short-lived access tokens and rotating opaque refresh tokens | No external identity provider; preserves a strong server-side revocation boundary     |
| Wallet custody          | Self-custodial; client signs                                                                                | Backend never needs plaintext user keys                                               |
| Initial environments    | Local + testnet/devnet                                                                                      | Mainnet remains gated                                                                 |
| Initial chain scope     | Explicit product decision; start with the smallest required set                                             | Avoid copying unused adapters/providers                                               |
| Market type             | Spot markets first                                                                                          | Aligns with the reference market system                                               |
| Quote model             | Provider-backed firm/executable quote with expiry                                                           | Prevents stale execution assumptions                                                  |
| Amount storage          | Integer base-unit strings                                                                                   | Avoids floating-point loss                                                            |
| Price/analytics storage | MySQL `DECIMAL` columns returned as strings                                                                 | Avoids financial precision errors and JavaScript coercion                             |
| API version             | `/v1`                                                                                                       | Allows non-breaking future evolution                                                  |
| One wallet per user     | Yes for first release                                                                                       | Simplifies ownership and balance aggregation                                          |

If TsionMarket means a prediction/order-book marketplace rather than crypto spot markets, the authentication, ownership, ledger, idempotency, audit, and operations phases still apply, but the quote/execution phases must be replaced with order-book, position, settlement, and resolution domains before implementation starts.

---

## 4. Non-negotiable security and financial invariants

1. Every protected `/v1/*` route authenticates a valid TsionMarket access token and an active user/session.
2. The immutable internal user ID is the ownership key; email, username, and phone number are never foreign keys for wallet or financial data.
3. Every wallet, account, balance, intent, quote, and transaction query derives ownership from the authenticated user.
4. User-controlled `userId`, `walletId`, or `accountId` values are never trusted without an ownership join.
5. Production never permits an authentication bypass.
6. Wallet provisioning, key generation, key encryption/recovery, wallet unlocking, and signing happen on the frontend. The backend accepts only validated public keys/addresses and signed transaction payloads.
7. The backend does not accept, generate, log, return, or persist plaintext private keys, seed phrases, wallet DEKs, or recovery secrets.
8. The client signs locally; the backend verifies that the signed payload exactly matches the reviewed intent.
9. A balance check is advisory before signing and is repeated where practical before submission; it is not a lock on on-chain funds.
10. All monetary amounts use base-unit integer strings. Floating-point arithmetic is forbidden for balances and execution amounts.
11. Quotes expire and cannot be executed after their expiry or after a material request mutation.
12. Mutating financial endpoints support idempotency and are safe under retries.
13. Network and account chain families must match.
14. All SQL values are parameterized; user input is never concatenated into SQL. Dynamic identifiers/order clauses use fixed server-side allowlists.
15. Multi-record financial/authentication changes use explicit MySQL transactions with intentional locking and isolation behavior.
16. Mainnet stays disabled until explicit release approval and operational gates pass.
17. Logs redact authorization headers, signed payloads where sensitive, provider credentials, and authentication artifacts.
18. Market data failure must not become permission to execute with incomplete validation.

---

## 5. Target architecture and source layout

```text
tsionmarket/
├── src/
│   ├── index.ts
│   ├── app.ts
│   ├── config/
│   │   ├── env.ts
│   │   ├── networks.ts
│   │   └── constants.ts
│   ├── db/
│   │   ├── pool.ts
│   │   ├── transaction.ts
│   │   ├── migrate.ts
│   │   └── queries/
│   │       ├── auth.sql.ts
│   │       ├── wallets.sql.ts
│   │       ├── markets.sql.ts
│   │       └── transactions.sql.ts
│   ├── api/
│   │   ├── middleware/
│   │   │   ├── requestId.ts
│   │   │   ├── errorHandler.ts
│   │   │   └── rateLimit.ts
│   │   └── routes/
│   │       ├── health.ts
│   │       ├── auth.ts
│   │       ├── wallets.ts
│   │       ├── balances.ts
│   │       ├── markets.ts
│   │       ├── quotes.ts
│   │       ├── transactions.ts
│   │       └── internal.ts
│   ├── auth/
│   │   ├── middleware.ts
│   │   ├── PasswordService.ts
│   │   ├── TokenService.ts
│   │   ├── SessionService.ts
│   │   ├── VerificationService.ts
│   │   ├── RecoveryService.ts
│   │   └── types.ts
│   ├── domain/
│   │   ├── auth.ts
│   │   ├── wallet.ts
│   │   ├── market.ts
│   │   └── transaction.ts
│   ├── wallet/
│   │   ├── accountRegistration/
│   │   ├── balances/
│   │   ├── chains/
│   │   ├── rpc/
│   │   └── transactions/
│   ├── markets/
│   │   ├── MarketRegistryService.ts
│   │   ├── QuoteService.ts
│   │   ├── BalanceGuardService.ts
│   │   ├── MarketDataService.ts
│   │   └── providers/
│   ├── workers/
│   │   ├── marketRegistry.ts
│   │   └── transactionReconciler.ts
│   ├── operations/
│   │   └── SystemControlService.ts
│   ├── scripts/
│   │   ├── seedNetworks.ts
│   │   ├── verifySchema.ts
│   │   └── verifyProductionConfig.ts
│   └── utils/
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── contract/
│   └── security/
├── docs/
│   ├── api-contract.md
│   ├── threat-model.md
│   └── runbooks/
├── docker/
│   └── mysql/
│       └── init.sql
├── migrations/
│   ├── 0001_auth.sql
│   ├── 0002_wallets_networks.sql
│   └── 0003_markets_transactions.sql
├── .env.example
├── docker-compose.yml
├── Dockerfile
├── package.json
├── tsconfig.json
└── BACKEND_IMPLEMENTATION_PLAN.md
```

---

## 6. Relational schema and direct-SQL conventions

All tables use InnoDB, `utf8mb4`, UTC timestamps, explicit foreign keys, and named unique/check constraints. IDs use one documented strategy consistently (recommended: application-generated UUIDv7 stored as `BINARY(16)`, exposed as canonical UUID strings). Financial base-unit values that may exceed MySQL numeric ranges are stored as validated digit strings; bounded prices and analytics use appropriately sized `DECIMAL` columns and are returned to JavaScript as strings.

Application code executes reviewed, parameterized SQL through `mysql2/promise`. Domain types are plain TypeScript types, not persisted model classes. Each query selects explicit columns; production code does not use `SELECT *`. SQL migrations are ordered, immutable after deployment, checksum-tracked in a `schema_migrations` table, and run by a dedicated migration command before application rollout—not implicitly by every API replica.

Multi-step operations use an acquired connection with explicit `BEGIN`, `COMMIT`, and `ROLLBACK`. Authentication rotation, idempotency, and transaction-state changes lock the controlling row with `SELECT ... FOR UPDATE` or use a guarded atomic `UPDATE ... WHERE status = ?`. Duplicate-key errors are mapped to stable domain errors rather than handled through preflight-only checks.

### Identity, credentials, sessions, and ownership

- `users`: immutable ID, normalized email, optional display profile, verification state, token version, and lifecycle (`pending_verification`, `active`, `locked`, `deleted`).
- `user_credentials`: user ID, Argon2id password hash, hash parameters/version, password-change timestamp, and failed-authentication metadata. Passwords are never reversibly encrypted.
- `auth_sessions`: user ID, hashed refresh-token identifier/secret, token family, device metadata, expiry, last use, rotation counter, and revocation reason. Raw refresh tokens are never stored.
- `auth_challenges`: hashed email-verification or password-reset token, purpose, user ID, attempts, expiry, and one-time consumption timestamp.
- `wallets`: backend ownership container/status for frontend-provisioned wallet metadata; it contains no key material and does not cause wallet creation.
- `wallet_accounts`: public key/address data registered only after the frontend provisions a cryptographic account.
- `wallet_addresses`: validated network-specific public addresses where required.

### Networks, balances, and markets

- `networks`: network ID, family, chain ID, environment, native asset, capabilities, enabled state, and RPC configuration references.
- `markets`: normalized market identity, network, venue, base/quote assets, decimals, token identifiers, price, liquidity, chart support, active state, and provider metadata.
- `quotes`: user, market/route, side, input/output assets, requested amount, expected amount, minimum received, fees, price impact, route payload hash, provider, expiry, and status.

### Transactions

- `transaction_intents`: user and public wallet-account ownership, quote link, chain/network, normalized review summary, exact unsigned transaction, validation/simulation output, idempotency key, expiry, and status.
- `transaction_records`: intent link, transaction hash, from/to, full trade summary, submitted/confirmed timestamps, status, and failure code.
- `security_events`: authentication, authorization, replay, policy rejection, pause, and sensitive lifecycle events.
- `operational_controls`: durable emergency pause state and reason.

### Required indexes

- Unique case-normalized `users(email)` (or a separate unique login-identity table if multiple login methods are added later).
- Unique `user_credentials(userId)`.
- Unique `auth_sessions(refreshTokenHash)` plus indexes on `{ userId, revokedAt, expiresAt }` and token family.
- Ordinary expiry indexes for authentication sessions/challenges; a scheduled cleanup job deletes expired rows in bounded batches because expiry indexes do not delete rows automatically.
- Unique primary `wallets(userId)` for release one.
- Unique `wallet_accounts(walletId, chainFamily)`.
- Unique `networks(networkId)`.
- Unique `markets(marketId)` and provider-specific identity index.
- Market browse index on `{ active, chartSupported, liquidityUsd, baseSymbol }`.
- Unique sparse `transaction_intents(userId, idempotencyKey)`.
- Unique `transaction_records(networkId, txHash)`.
- Expiry indexes on transient authentication challenges and quote artifacts, with bounded scheduled cleanup.
- Reconciliation index on transaction status and update time.

---

## 7. API contract outline

All successful responses:

```json
{ "success": true, "data": {} }
```

All failures:

```json
{
  "success": false,
  "error": { "code": "INSUFFICIENT_BALANCE", "message": "Insufficient USDC balance" },
  "requestId": "..."
}
```

### Public operational routes

```text
GET  /health
GET  /ready
```

### Authenticated identity and wallet routes

```text
POST /v1/auth/register
POST /v1/auth/verify-email
POST /v1/auth/resend-verification
POST /v1/auth/login
POST /v1/auth/refresh
POST /v1/auth/logout
POST /v1/auth/logout-all
GET  /v1/auth/sessions
DELETE /v1/auth/sessions/:sessionId
POST /v1/auth/change-password
POST /v1/auth/forgot-password
POST /v1/auth/reset-password
GET  /v1/auth/me
GET  /v1/wallets/me
POST /v1/wallets/me/accounts/challenge
POST /v1/wallets/me/accounts
GET  /v1/wallets/me/accounts
DELETE /v1/wallets/me/accounts/:accountId
GET  /v1/wallets/me/balances
GET  /v1/wallets/me/accounts/:accountId/balances?networkId=...
GET  /v1/networks
```

### Market and quote routes

```text
GET  /v1/markets?networkId=&query=&limit=&cursor=
GET  /v1/markets/:marketId
GET  /v1/markets/:marketId/price
GET  /v1/markets/:marketId/chart?interval=&from=&to=
POST /v1/quotes
GET  /v1/quotes/:quoteId
POST /v1/quotes/:quoteId/intents
```

### Transaction routes

```text
GET  /v1/transactions?limit=&cursor=
GET  /v1/transactions/:transactionId
GET  /v1/transactions/intents/:intentId
POST /v1/transactions/intents/:intentId/simulate
POST /v1/transactions/intents/:intentId/submit
```

### Internal operational routes

```text
GET  /internal/v1/ping
GET  /internal/v1/control/status
POST /internal/v1/control/pause
POST /internal/v1/control/resume
POST /internal/v1/markets/refresh
```

Internal routes require a separate service secret or workload identity and must never substitute for end-user authentication.

`POST /v1/wallets/me/accounts` does **not** provision a wallet. The frontend first generates and secures the wallet locally, then submits only the chain family, public key/address, derivation metadata safe to disclose, and a signed ownership challenge. The backend validates the address/public-key relationship and proof before registering the public account metadata.

---

## 8. Phase-by-phase implementation

## Phase 0 — Product contract and reference extraction

### Deliverables

- Confirm spot-market product scope, initial networks, assets, venues, order sides, and regions.
- Confirm the login identifiers (email initially), verification provider, password policy, access-token lifetime, refresh-session lifetime, cookie/client storage strategy, and account recovery policy.
- Inventory reference modules as `port`, `adapt`, or `exclude`.
- Write `docs/api-contract.md`, terminology, error catalogue, and initial sequence diagrams.
- Create a threat model covering account takeover, cross-user access, quote tampering, replay, stale prices, RPC/provider compromise, double submission, and secret leakage.
- Define latency and availability targets for auth, balances, market listing, quotes, and submission.

### Exit criteria

- Stakeholders approve chain/venue scope and custody model.
- Every endpoint has an owner, authentication class, input/output schema, and error behavior.
- No unresolved ambiguity remains between spot markets and a prediction/order-book marketplace.

## Phase 1 — Service foundation and local infrastructure

### Deliverables

- Scaffold Node.js/TypeScript ESM, Express, Zod, `mysql2/promise`, Winston, Vitest, ESLint, and formatting. Do not install an ORM.
- Add environment validation that fails at startup for unsafe or incomplete configuration.
- Add request IDs, structured errors, Helmet, explicit CORS allowlist, JSON size limits, graceful shutdown, and global/default route rate limits.
- Add Dockerfile and Docker Compose with a pinned MySQL 8.x image, health check, non-root application database user, separate migration credentials where needed, persistent named volume, and development-only port exposure.
- Configure a bounded MySQL connection pool, connection/acquisition/query timeouts, `decimalNumbers: false`, UTC session timezone, strict SQL mode, and clean shutdown.
- Add direct-SQL migration infrastructure with immutable numbered `.sql` files, checksums, advisory migration locking, forward-only production execution, and a documented restore/roll-forward procedure.
- Add `/health` for process liveness and `/ready` for database and required dependency readiness.
- Add CI commands for install, typecheck, test, build, dependency audit, and container build.

### Tests

- Environment validation and production-auth-bypass rejection.
- Response envelope and request ID propagation.
- CORS and security-header behavior.
- Readiness failure when MySQL is unavailable or required migrations have not been applied.
- Migration ordering/checksum behavior, pool exhaustion behavior, rollback on transaction failure, and rejection of unsafe dynamic SQL.

### Exit criteria

- A fresh checkout can start locally from documented commands.
- CI passes with deterministic lockfile installs.

## Phase 2 — First-party authentication and session security

**Implementation status:** Complete in code. Live Docker/MySQL migration and end-to-end email-provider verification remain environment-dependent validation gates.

### Deliverables

- Implement registration with canonicalized email, generic conflict behavior where enumeration is a concern, and explicit acceptance of required legal terms/version.
- Hash passwords with Argon2id using OWASP-aligned, deployment-benchmarked parameters and a server-side pepper held outside MySQL. Store the algorithm and parameters for future rehashing.
- Enforce a minimum password length, allow password managers/paste, reject known-compromised passwords when a privacy-preserving check is available, and do not impose composition rules that encourage weak patterns.
- Implement one-time, random, hashed, expiring email-verification challenges. Do not activate financial operations before the required verification state.
- Implement login with constant-behavior failure responses, per-IP and per-account throttling, escalating temporary lockout, and security-event recording.
- Issue a short-lived signed access token containing only immutable user ID, session ID, token version, issue time, and expiry. Validate signature, algorithm, issuer, audience, expiry, session revocation, user state, and token version.
- Issue a high-entropy opaque refresh token. Store only its keyed hash, rotate it inside one MySQL transaction on every refresh, lock the active session/token-family row, detect reuse of an already-rotated token, and revoke the entire token family on reuse.
- Prefer `HttpOnly`, `Secure`, appropriately scoped `SameSite` cookies for browser refresh tokens. If cookie authentication is used for a state-changing request, add CSRF protection and strict Origin checking. Keep short-lived access tokens in memory where practical.
- Implement logout, logout-all, session listing/revocation if exposed, password change, forgot-password, and reset-password. Password reset revokes all existing sessions and increments the token version.
- Make verification and recovery responses resistant to email enumeration. Email links/codes are single-use, attempt-limited, and short-lived.
- Implement `AuthenticatedRequest`, `requireIdentity`, and `GET /v1/auth/me`; downstream services receive the immutable internal user ID, never an email lookup.
- Define authentication-key rotation with `kid` support and an overlap window; keep signing keys and password pepper in a secrets manager/environment injection, never in source.
- Allow a fixed development identity only in automated tests or an explicit local-only test harness that cannot start in staging/production.
- Add auth-specific request/body limits, audit events, redaction, and stable error codes.

### Tests

- Registration uniqueness races enforced by a unique SQL constraint, email normalization, weak/compromised password rejection, password hash verification, and automatic rehash when parameters change.
- Valid login plus wrong-password, unknown-user, unverified, locked, and deleted-user behavior without account enumeration.
- Access tokens with invalid signature/algorithm, wrong issuer/audience, expiry, missing session, revoked session, and stale token version.
- Refresh rotation, concurrent refresh, replay/reuse detection, family revocation, expiry, logout, and logout-all.
- Verification/reset challenge expiry, attempt limits, one-time consumption, token hashing, resend throttling, and session revocation after password reset.
- CSRF and Origin enforcement when cookies are used.
- Production startup failure when authentication safeguards or secrets are missing/unsafe.
- No password, raw verification/reset/refresh token, access token, cookie, or authentication secret leakage in logs/errors.

### Exit criteria

- All `/v1` routes reject unauthenticated requests consistently.
- Registration, verification, login, refresh, logout, and recovery work end to end.
- A compromised database does not reveal plaintext passwords or usable refresh, verification, or recovery tokens.
- Revoking a session or resetting a password blocks subsequent access under the defined revocation-latency target.

## Phase 3 — Frontend-provisioned wallet registration and ownership metadata

**Frontend implementation contract:** See `PHASE_3_FRONTEND_IMPLEMENTATION_PLAN.md`. Wallet key generation, envelope encryption, local encrypted-package storage, passphrase/PIN unlock, signing, and new-family provisioning are frontend responsibilities. The backend stores only public ownership/network metadata and one-time ownership challenges.

### Deliverables

- Define clearly that the frontend generates wallet keys, encrypts/stores recovery material, provisions accounts, unlocks the wallet, and signs. None of those operations are backend responsibilities.
- Use frontend envelope encryption: generate one random 32-byte wallet DEK; encrypt every account private key independently with AES-256-GCM and unique IV/AAD; derive a passphrase KEK from the user's exact passphrase (minimum 12 characters) using versioned Argon2id parameters; wrap the DEK rather than encrypting every private key directly with the passphrase.
- Support local device PIN unlock by adding a device-bound, nested PIN envelope around the same DEK. A PIN never replaces the passphrase, recovery path, DEK, wallet, or addresses. Do not ship a portable PIN-only wrapper that permits offline numeric-PIN brute force.
- Require either an active approved unlock window, a freshly entered passphrase, or a device-bound PIN unlock before local transaction signing. Private keys are decrypted only for the specific signing operation and wiped immediately afterward.
- Keep the encrypted wallet package in frontend-controlled IndexedDB and support explicit encrypted backup/export. The backend does not store the encrypted package in this release.
- Implement MySQL tables, foreign keys, constraints, and direct parameterized queries for the backend wallet ownership container, registered public accounts/addresses, ownership challenges, and networks.
- Implement ownership-safe `GET /v1/wallets/me` and idempotent `POST /v1/wallets/me/accounts` for registering an already-provisioned frontend account.
- Require a short-lived, one-time backend challenge signed by the newly provisioned wallet before account registration. Verify the signature and public-key/address derivation for the chain family, then consume the challenge in the same SQL transaction as registration.
- Reject private-key, seed-phrase, recovery-secret, encrypted-key-package, or wallet-DEK fields at schema validation, including unknown sensitive-looking fields.
- Seed only approved development/test networks.
- Expose a capability-rich, versioned network catalogue so the frontend never hard-codes the enabled network set. Distinguish a chain family/account from a network deployment: adding another EVM network reuses the existing EVM key/address; adding a new family provisions exactly one new local account and registers only its public metadata.
- Make network/account registration idempotent and resumable using stable operation IDs. A failed backend registration must leave the encrypted local account pending—not silently generate another key on retry.
- Add adapter interface and registry for address validation, balances, transaction building, validation, simulation, submission, and status.
- Port only the selected chain adapters from Worldstreet.
- Do not port backend wallet-package persistence or backend provisioning from Worldstreet. If cross-device wallet recovery is later required, design it as a separately reviewed client-encrypted backup feature; it is not part of this release.

### Tests

- Repeated registration of the same frontend-provisioned account is idempotent for its owner.
- Invalid, expired, replayed, wrong-user, wrong-chain, and incorrectly signed ownership challenges are rejected.
- Cross-user wallet/account lookup returns not found.
- Address normalization and network-family mismatch rejection.
- Unique-index race handling.

### Exit criteria

- No route can select another user's wallet through request parameters.
- No private key or recovery material exists in backend inputs, SQL tables, logs, or fixtures.
- The frontend can provision and prove ownership of a wallet without sending secret material to the backend.

## Phase 4 — Network adapters, RPC resilience, and balance checking

### Deliverables

- Implement per-network primary/fallback RPC configuration and bounded retry/cooldown behavior.
- Implement native and allowlisted token balance reads in each selected adapter.
- Build an aggregated balance snapshot service modeled on Worldstreet:
  - derive registered public wallet accounts from the authenticated user;
  - query only active account/network pairs;
  - cap concurrency;
  - coalesce simultaneous refreshes per user;
  - impose an overall timeout;
  - return per-network `ready` or `unavailable` state;
  - use a short cache and clearly identify stale fallback data.
- Never scan the entire market catalogue with one RPC `balanceOf` call per token.
- Support provider-indexed discovery where trustworthy, plus a small canonical asset allowlist fallback.
- Return raw base units, decimals, symbol, token identifier, and formatted display value.

### Balance/spendability rules

Before creating an intent, calculate:

```text
required source asset = requested sell amount
required native asset = estimated network fee + configured safety buffer
required allowance    = requested ERC-20 amount, when applicable
```

- Native-asset sales must reserve the estimated fee instead of allowing the full displayed balance to be sold.
- Token sales require both sufficient token balance and sufficient native fee balance.
- Existing token allowance is read before generating a separate approval intent.
- Fee estimates and balance snapshots include timestamps and are revalidated when an expired quote is replaced.
- Provider errors return `BALANCE_UNAVAILABLE`; they are not converted into zero balances.

### Tests

- Native/token balances, zero balances, large integer values, token decimals, provider timeout, fallback, stale cache, and partial-network failure.
- Insufficient source token, insufficient gas, exact-boundary amounts, and concurrent refresh coalescing.

### Exit criteria

- The API gives deterministic, precision-safe spendability results.
- One failed network does not erase successful balances from other networks.

## Phase 5 — Market catalogue and market-data registry

### Deliverables

- Define a provider-neutral market model with stable `marketId` values.
- Implement provider adapters for the approved venues only.
- Build a background registry worker with explicit enable flag, delayed startup, bounded pages/concurrency, retry/backoff, and last-success metrics.
- Normalize base/quote identifiers and decimals at ingestion.
- Validate token addresses/mints and reject malformed provider rows.
- Deactivate missing/delisted markets without destructive deletion.
- Rank markets by verified liquidity/volume and suppress unpriced or non-executable entries.
- Implement cursor pagination, network/venue filters, search, and stable sorting.
- Keep catalogue reads available from the last successful snapshot during provider outages.
- Add canonical fallback markets only if the product explicitly approves them; mark them as fallback data.

### Tests

- Provider normalization, duplicate merging, delisting, malformed assets, pagination stability, ranking, empty registry, and stale registry behavior.

### Exit criteria

- Every returned market maps to an enabled network and a supported execution provider.
- Market browsing does not require a live provider request on every user call.

## Phase 6 — Quotes, affordability, and route validation

### Deliverables

- Implement `POST /v1/quotes` with market/route, side, amount, slippage, account, and optional idempotency key.
- Normalize human amounts into base units using server-known asset decimals.
- Fetch a provider quote server-side and validate its chain, tokens, recipient, spender, calldata destination, value, amount, and expiry.
- Calculate expected output, minimum received, provider fee, platform fee if approved, network fee estimate, price impact, and total required balances.
- Run the balance/spendability guard before returning an executable result.
- Persist a quote snapshot or signed/hash-bound quote reference so later intent creation cannot mutate it.
- Distinguish `INSUFFICIENT_ASSET_BALANCE`, `INSUFFICIENT_FEE_BALANCE`, `QUOTE_EXPIRED`, `MARKET_UNAVAILABLE`, `SLIPPAGE_TOO_HIGH`, and `BALANCE_UNAVAILABLE`.
- Never trust price, decimals, token address, route, fee, recipient, or calldata supplied by the client.

### Tests

- Buy/sell semantics, decimal conversion, tiny/huge amounts, stale quote, provider token mismatch, recipient mismatch, route mutation, price impact cap, and all affordability branches.

### Exit criteria

- A quote is either non-executable market information or a time-bounded, validated execution input; the API states which.
- An intent cannot be created from an expired or altered quote.

## Phase 7 — Transaction intents, approvals, and local signing

### Deliverables

- Create a transaction intent from a validated quote.
- For ERC-20 routes, check allowance and create a separate exact-amount approval intent only when required.
- Build the complete unsigned chain-native transaction with nonce/blockhash, chain ID, fee fields, gas/compute limits, destination, calldata/instructions, and value.
- Validate and simulate before returning the intent.
- Store the exact unsigned transaction and a normalized human-readable review summary.
- Return the correct signing encoding to the client without returning provider credentials.
- Use compare-and-set status transitions and unique idempotency keys.
- Define a state machine:

```text
created -> awaiting_approval -> awaiting_signature -> submitted
   |              |                  |                  |
   +--------------+------------------+-----------> expired/failed
                                                      |
                                                      v
                                             confirmed/unknown
```

### Tests

- Idempotent retries, concurrent creates, simulation failure, altered nonce/gas/fee/destination/calldata/value/network, approval pending/retry behavior, and expired intents.

### Exit criteria

- The user sees all material transaction details before signing.
- The backend cannot silently replace the reviewed trade with another transaction.

## Phase 8 — Submission, reconciliation, and history

### Deliverables

- Accept only the signed transaction encoding expected by the intent's adapter.
- Cryptographically verify signatures where supported and verify exact message/payload equivalence everywhere.
- Broadcast once using an atomic state transition; safely return the prior result on an idempotent retry.
- Store transaction records with full market summary, both trade assets, amounts, venue, network, quote/intent IDs, and timestamps.
- Implement a bounded reconciliation worker for submitted transactions.
- Classify confirmed, failed, pending, dropped/replaced, expired, and provider-unknown states.
- Avoid infinite polling of permanently unknown transactions; retain a manual repair path.
- Implement cursor-based user history with ownership filters and no N+1 intent reads.

### Tests

- Double-submit race, provider timeout after accepted broadcast, duplicate transaction hash, confirmation, revert/failure, replacement, temporary RPC outage, and complete history summaries.

### Exit criteria

- Every accepted submission is auditable from quote through final status.
- Reconciliation is restart-safe and does not create duplicate financial records.

## Phase 9 — Security hardening and abuse controls

### Deliverables

- Add route-specific limits for authentication, balances, quotes, intent creation, and submission.
- Add payload size limits, strict schemas, unknown-field rejection on sensitive endpoints, and safe URL handling.
- Emit structured security events for denied ownership access, replay, tampering, suspicious quote volume, and repeated submission failures.
- Add durable emergency pause controls that block quotes intended for execution, intent creation, and submission while preserving read-only access.
- Validate secrets/configuration at startup; prohibit development defaults outside local/test.
- Add dependency and container scanning, secret scanning, SBOM generation, and pinned CI actions.
- Complete an internal security review and commission an independent review before meaningful mainnet funds.

### Exit criteria

- Threat-model controls have tests and operational owners.
- The service fails closed under missing auth, database uncertainty, provider mismatch, and unsafe production configuration.

## Phase 10 — Observability and operational readiness

### Deliverables

- Metrics: request latency/error rate, auth failures, balance provider latency, cache freshness, market registry age/count, quote success/rejection, simulation failures, submission outcomes, reconciliation backlog, and RPC failover.
- Correlated logs using request, user-safe pseudonymous, quote, intent, and transaction identifiers.
- Alerts for stale market registry, elevated auth errors, provider error rate, reconciliation backlog, MySQL/pool failure, replica lag if replicas are introduced, and emergency pause changes.
- Runbooks for RPC failover, provider outage, stale markets, stuck transactions, authentication key/pepper rotation, MySQL backup/restore and point-in-time recovery, migration failure, pause/resume, and incident response.
- Production configuration verifier and database index verifier.

### Exit criteria

- An operator can diagnose a failed trade without viewing secrets or private keys.
- Backup/restore, provider failover, and pause/resume drills have recorded evidence.

## Phase 11 — Staging, mainnet gates, and progressive rollout

### Deliverables

- Run end-to-end tests on testnet/devnet using actual clients and wallets.
- Run a staging soak covering quote refresh, concurrency, provider degradation, restarts, and reconciliation.
- Load-test market browsing, aggregate balances, quote bursts, and submission idempotency.
- Require `NETWORK_MODE=mainnet`, `ENABLE_MAINNET=true`, and a separate release approval gate.
- Start with internal allowlisted users and capped transaction values.
- Roll out by network/venue, not all providers simultaneously.
- Define rollback as disabling new execution while continuing reconciliation and read access.

### Production release gates

- Independent security review complete.
- All high/critical findings remediated or formally accepted.
- CI integration tests use a real disposable MySQL container and exercise the same isolation, constraints, migrations, and locking semantics used in production.
- Backup/restore and RPC failover drills pass.
- Provider contracts, credentials, quotas, and legal/compliance obligations are approved.
- Dashboards and alerts are live.
- Limited-funds canary succeeds before broad access.

### Exit criteria

- Release owner signs off every gate.
- Mainnet activation is reversible without data loss or abandoned submitted transactions.

## Phase 12 — Post-launch improvements

Only begin after the initial release is stable:

- Additional chains and market providers through adapter contracts.
- WebSocket/SSE price and transaction updates with authenticated subscription ownership.
- Portfolio valuation and P&L using timestamped price provenance.
- Advanced orders only after defining cancellation, partial-fill, and settlement semantics.
- Sponsored transactions with per-user/network/operation budgets and fraud controls.
- Audited delegated/session authority; a database bearer token alone is never treated as chain authority.
- Multi-wallet support and account selection.

---

## 9. Testing strategy

### Unit tests

- Environment rules, schemas, amount conversion, asset normalization, balance guards, state transitions, provider normalization, and error mapping.

### Integration tests

- MySQL constraints, transaction rollback/deadlock retry, uniqueness/idempotency races, direct-SQL parameterization, first-party authentication/session rotation, wallet ownership joins, balance caching, quote persistence, intent creation, and reconciliation.

### Contract tests

- Recorded/sandbox responses for each market, quote, RPC, and indexer provider.
- Detect upstream field and semantic changes before deployment.

### Security tests

- Cross-user object access, token algorithm/key confusion, refresh replay, session fixation, credential stuffing controls, account enumeration, CSRF, auth bypass, duplicate submission, intent mutation, SSRF/input injection, secret redaction, and emergency pause enforcement.

### End-to-end tests

- Register/verify/login -> frontend provisions wallet -> prove/register public account -> read balances -> browse market -> quote -> affordability check -> approve if needed -> sign locally -> submit -> reconcile -> view history.

### Minimum CI quality gate

```text
typecheck
unit tests
integration tests
security tests
production build
dependency audit/review
container build
index/config verification
```

Coverage percentage alone is not the release gate; all financial state transitions and negative authorization paths must have explicit tests.

---

## 10. Suggested implementation milestones

| Milestone                  | Included phases | Demonstrable outcome                                         |
| -------------------------- | --------------- | ------------------------------------------------------------ |
| M1 — Secure skeleton       | 0–2             | Authenticated service with normalized users                  |
| M2 — Wallet reads          | 3–4             | User-owned accounts and resilient balances                   |
| M3 — Markets               | 5               | Searchable, normalized, cached market catalogue              |
| M4 — Trade preparation     | 6–7             | Affordable validated quote becomes a locally signable intent |
| M5 — Trade lifecycle       | 8               | Submission, reconciliation, and complete history             |
| M6 — Release candidate     | 9–10            | Hardened and observable staging service                      |
| M7 — Controlled production | 11              | Gated mainnet canary and progressive rollout                 |

Each milestone should be independently reviewable and deployable. Do not begin mainnet enablement merely because feature development is complete.

---

## 11. Definition of done

The backend is considered complete for the initial release only when:

- Authentication and ownership invariants are enforced on every user resource.
- Wallet and market operations never require server-side plaintext user keys.
- Balances are precision-safe, timestamped, resilient, and distinguish unavailable from zero.
- Market records are normalized, executable, ranked, paginated, and available through provider outages using a known snapshot.
- Quotes are validated, expiring, tamper-bound, and affordability-checked.
- Intents are simulated and exact signed-payload equivalence is enforced.
- Idempotent retries cannot create duplicate intents, broadcasts, or records.
- Reconciliation produces a durable final or explicitly unknown state.
- Security, integration, provider-contract, and end-to-end tests pass.
- Production defaults fail closed and mainnet requires explicit approval.
- Dashboards, alerts, runbooks, backup/restore, and incident controls are operational.
- API documentation and client integration examples match the deployed contract.

---

## 12. First implementation slice

The recommended first pull request should contain only:

1. Project scaffold and validated configuration.
2. Containerized MySQL, direct-SQL pool, migration runner, initial auth migration, and health/readiness routes.
3. Request ID, error envelope, Helmet, CORS, and rate limiting.
4. First-party registration/login foundation, password hashing, access/refresh token services, and `GET /v1/auth/me`.
5. Direct SQL for `users`, `user_credentials`, `auth_sessions`, and `auth_challenges`, including foreign keys, unique constraints, expiry indexes, and transaction tests.
6. Unit/integration tests and local Docker instructions.

This creates the secure identity foundation that every wallet, balance, market, quote, and transaction feature depends on, while keeping the first review small enough to verify thoroughly.
