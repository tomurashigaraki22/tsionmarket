# TsionMarket HTTP API contract

This document describes the API currently mounted by the application. It is the contract used by the web client; planned routes must not appear here until implemented.

## Conventions

- Product base path: `/v1`.
- Success: `{ "success": true, "data": ... }`.
- Failure: `{ "success": false, "error": { "code", "message", "details"? }, "requestId" }`.
- Token and currency amounts are unsigned base-unit decimal strings, never JSON floating-point numbers.
- Timestamps are UTC ISO-8601 strings; exposed authenticated-resource IDs are UUIDs.
- Pagination uses an opaque `cursor` and bounded `limit`.
- Bodies and documented query strings are strict; unknown fields are validation errors.
- Authenticated routes require `Authorization: Bearer <accessToken>` unless stated otherwise.
- Refresh requires the HttpOnly refresh cookie, matching CSRF cookie/header, and an allowed `Origin`.

## Endpoint catalogue

| Method   | Path                                       | Access                      | Success |
| -------- | ------------------------------------------ | --------------------------- | ------: |
| `GET`    | `/health`                                  | Public                      |     200 |
| `GET`    | `/ready`                                   | Public                      | 200/503 |
| `POST`   | `/v1/auth/register`                        | Public, rate-limited        |     202 |
| `POST`   | `/v1/auth/verify-email`                    | Public, rate-limited        |     200 |
| `POST`   | `/v1/auth/resend-verification`             | Public, rate-limited        |     202 |
| `POST`   | `/v1/auth/login`                           | Public, rate-limited        |     200 |
| `POST`   | `/v1/auth/refresh`                         | Refresh cookie + CSRF       |     200 |
| `POST`   | `/v1/auth/logout`                          | Authenticated               |     200 |
| `POST`   | `/v1/auth/logout-all`                      | Authenticated               |     200 |
| `GET`    | `/v1/auth/sessions`                        | Authenticated               |     200 |
| `DELETE` | `/v1/auth/sessions/:sessionId`             | Authenticated               |     200 |
| `POST`   | `/v1/auth/forgot-password`                 | Public, rate-limited        |     202 |
| `POST`   | `/v1/auth/reset-password`                  | Public, rate-limited        |     200 |
| `POST`   | `/v1/auth/change-password`                 | Authenticated, rate-limited |     200 |
| `GET`    | `/v1/auth/me`                              | Authenticated               |     200 |
| `GET`    | `/v1/networks`                             | Authenticated               |     200 |
| `GET`    | `/v1/wallets/me/accounts`                  | Authenticated               |     200 |
| `POST`   | `/v1/wallets/me/accounts/challenge`        | Authenticated, rate-limited |     201 |
| `POST`   | `/v1/wallets/me/accounts`                  | Authenticated, rate-limited | 200/201 |
| `GET`    | `/v1/wallets/me/balances`                  | Authenticated               |     200 |
| `GET`    | `/v1/markets`                              | Authenticated               |     200 |
| `POST`   | `/v1/quotes`                               | Authenticated, rate-limited |     201 |
| `POST`   | `/v1/transaction-intents`                  | Authenticated, rate-limited | 200/201 |
| `POST`   | `/v1/transaction-intents/:intentId/submit` | Authenticated, rate-limited | 200/202 |
| `GET`    | `/v1/transactions`                         | Authenticated               |     200 |
| `GET`    | `/v1/transactions/:transactionId`          | Authenticated               |     200 |
| `GET`    | `/v1/portfolio/valuation`                  | Authenticated               |     200 |
| `GET`    | `/v1/portfolio/valuation/history`          | Authenticated               |     200 |
| `GET`    | `/v1/capabilities`                         | Authenticated               |     200 |
| `GET`    | `/v1/transactions/stream`                  | Authenticated               | 200 SSE |

## Authentication

```text
register              { email, password, termsVersion }
verify-email          { token: sixDigitCode }
resend-verification   { email }
login                 { email, password }
forgot-password       { email }
reset-password        { token, newPassword }
change-password       { currentPassword, newPassword }
```

Email verification accepts a six-digit OTP, not a link. Login is rejected until verification. Login and refresh return `{ accessToken, tokenType: "Bearer", expiresIn, sessionId }`. `/auth/me` returns `{ user: { id, email }, sessionId }`; clients must not synthesize a guest user.

## Networks and portfolio

`GET /v1/networks` returns records containing `networkId`, `family`, `name`, `environment`, optional `chainId`/`cluster`, `nativeSymbol`, `nativeDecimals`, trusted explorer templates, and explicit `capabilities` flags for balance reads, quotes, intents, submission, and sponsorship. Only enabled networks are returned.

`GET /v1/wallets/me/accounts` returns `{ id, networkId, address, family, ownershipStatus }[]`. Legacy accounts are `unverified` and cannot request executable quotes.

`POST /v1/wallets/me/accounts/challenge` accepts `{ networkId, address }`. It returns a five-minute, single-use challenge containing `challengeId`, the canonical human-readable `statement`, `nonce`, normalized address, authenticated user binding, issue/expiry timestamps, and `signatureScheme`.

`POST /v1/wallets/me/accounts` accepts `{ challengeId, networkId, address, signature, publicKey?, label?, idempotencyKey }`. The signature must be EIP-191 for EVM or Ed25519 for Solana. The challenge is user/address/network bound, attempts are limited, address ownership is globally exclusive per network, and a matching idempotent retry returns the existing account.

`GET /v1/wallets/me/balances?refresh=true|false` aggregates verified accounts only and returns `{ asOf, stale, accounts, errors }`. Each account includes `{ accountId, networkId, address, assets, state, observedAt, providerStatus, error? }`; each asset includes `{ assetId, symbol, decimals, raw, formatted, supported }`. Provider failures and timeouts are isolated per account, so successful balances remain available in a partial response.

## Markets and execution

`GET /v1/markets` accepts `networkId?`, `venue?: "0x" | "jupiter"`, `search?`, `limit?` (1–100, default 50), and `cursor?`. It returns `{ items, nextCursor, stale, lastSuccessfulSync }`. Price/liquidity/volume fields are decimal strings or `null`.

`POST /v1/quotes` accepts `{ marketId, side: "buy" | "sell", amountRaw, sourceAccountId, slippageBps? }`. `slippageBps` defaults to 50 and is bounded to 1–5000. `amountRaw` must match `^[1-9]\\d*$`.

`POST /v1/transaction-intents` accepts `{ quoteId: uuid, idempotencyKey }`. An idempotent replay returns 200; creation returns 201. Its data is `{ intent, existing, requiresApproval? }`.

`POST /v1/transaction-intents/:intentId/submit` accepts `{ signedTransaction }`. An idempotent replay returns 200; accepted submission returns 202. Execution can return `EXECUTION_PAUSED` when operational controls pause quotes or intents.

## Transactions

`GET /v1/transactions` accepts `limit?` (1–100, default 50) and opaque `cursor?`, returning `{ items, nextCursor }`. `GET /v1/transactions/:transactionId` only returns an owned record.

`GET /v1/transactions/stream` emits SSE events: `ready` (`{ "connected": true }`), `transaction` (transaction record), and `unavailable` (`{ "retry": true }`), with five-second heartbeats. The connection closes after five minutes; clients reconnect with backoff.

## Valuation and capabilities

`GET /v1/portfolio/valuation` returns decimal USD totals with `currency: "USD"`, `decimalPrecision: 8`, nullable position price/value fields, price and observation timestamps, stale state, and `status: "unavailable" | "partial" | "zero" | "complete"`. P&L remains unavailable until a supported cost basis exists.

`GET /v1/portfolio/valuation/history?limit=30` accepts 1–100 and returns user-scoped `{ asOf, totalValueUsd, pricedValueUsd, unpricedAssetCount }[]` points in deterministic newest-first order.

`GET /v1/capabilities` returns chain adapters, sponsorship availability, advanced-order availability/reason, transaction-stream transport/path, and live quote/intent pause controls. UI availability must follow these flags.

## Stable error behavior

| Code                     | HTTP | Meaning                                       |
| ------------------------ | ---: | --------------------------------------------- |
| `VALIDATION_ERROR`       |  400 | Body, parameter, or query failed validation   |
| `INVALID_CREDENTIALS`    |  401 | Login credentials are invalid                 |
| `AUTH_REQUIRED`          |  401 | Access token or active session is missing     |
| `CSRF_VALIDATION_FAILED` |  403 | Refresh origin/cookie/header check failed     |
| `NOT_FOUND`              |  404 | Route or resource is unavailable              |
| `TRANSACTION_NOT_FOUND`  |  404 | Owned transaction was not found               |
| `RATE_LIMITED`           |  429 | Request limit exceeded                        |
| `EXECUTION_PAUSED`       |  503 | Operational control paused execution          |
| `SERVICE_NOT_READY`      |  503 | Dependency or schema readiness failed         |
| `INTERNAL_ERROR`         |  500 | Unexpected error; internals are not disclosed |

The failure `requestId` is safe to display in support UI and logs.
