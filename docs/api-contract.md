# API Contract

## Conventions

- Base path for product APIs: `/v1`.
- Content type: `application/json`.
- Amounts: unsigned base-unit decimal strings; never JSON floating-point numbers.
- Timestamps: UTC ISO 8601 in the API and UTC `TIMESTAMP(6)` in MySQL.
- IDs: canonical UUID strings externally.
- Pagination: opaque cursor plus bounded `limit`.
- Caller request IDs are accepted only in a safe character/length format; otherwise the server generates one.

Success:

```json
{ "success": true, "data": {} }
```

Failure:

```json
{
  "success": false,
  "error": { "code": "VALIDATION_ERROR", "message": "Request validation failed" },
  "requestId": "c0a8012e-..."
}
```

## Authentication classes

| Class         | Meaning                                                                     |
| ------------- | --------------------------------------------------------------------------- |
| Public        | No user identity; strict rate limiting still applies                        |
| Authenticated | Valid access token plus active user/session                                 |
| Wallet-owned  | Authenticated plus account ownership verified by SQL join                   |
| Internal      | Separate service credential/workload identity; never substitutes for a user |

Phase 1 implements only public health/readiness endpoints. Phase 2 adds authentication endpoints. Subsequent endpoints remain contract reservations until their phase is implemented.

## Endpoint catalogue

| Method and path                                  | Class         | Owner        | Phase | Key errors                                                                     |
| ------------------------------------------------ | ------------- | ------------ | ----: | ------------------------------------------------------------------------------ |
| `GET /health`                                    | Public        | Platform     |     1 | none                                                                           |
| `GET /ready`                                     | Public        | Platform     |     1 | `SERVICE_NOT_READY`                                                            |
| `POST /v1/auth/register`                         | Public        | Auth         |     2 | `VALIDATION_ERROR`, `RATE_LIMITED`                                             |
| `POST /v1/auth/verify-email`                     | Public        | Auth         |     2 | `CHALLENGE_INVALID`, `CHALLENGE_EXPIRED`                                       |
| `POST /v1/auth/login`                            | Public        | Auth         |     2 | `INVALID_CREDENTIALS`, `ACCOUNT_UNAVAILABLE`                                   |
| `POST /v1/auth/refresh`                          | Public/cookie | Auth         |     2 | `SESSION_INVALID`, `TOKEN_REUSE_DETECTED`                                      |
| `POST /v1/auth/logout`                           | Authenticated | Auth         |     2 | `AUTH_REQUIRED`                                                                |
| `GET /v1/auth/me`                                | Authenticated | Auth         |     2 | `AUTH_REQUIRED`                                                                |
| `POST /v1/wallets/me/accounts/challenge`         | Authenticated | Wallet       |     3 | `AUTH_REQUIRED`, `RATE_LIMITED`                                                |
| `POST /v1/wallets/me/accounts`                   | Authenticated | Wallet       |     3 | `OWNERSHIP_PROOF_INVALID`, `CHALLENGE_EXPIRED`                                 |
| `GET /v1/wallets/me`                             | Authenticated | Wallet       |     3 | `AUTH_REQUIRED`                                                                |
| `GET /v1/wallets/me/balances`                    | Authenticated | Wallet       |     4 | `BALANCE_UNAVAILABLE`                                                          |
| `GET /v1/markets`                                | Authenticated | Markets      |     5 | `VALIDATION_ERROR`                                                             |
| `POST /v1/quotes`                                | Wallet-owned  | Markets      |     6 | `MARKET_UNAVAILABLE`, `INSUFFICIENT_ASSET_BALANCE`, `INSUFFICIENT_FEE_BALANCE` |
| `POST /v1/quotes/:quoteId/intents`               | Wallet-owned  | Transactions |     7 | `QUOTE_EXPIRED`, `QUOTE_TAMPERED`                                              |
| `POST /v1/transactions/intents/:intentId/submit` | Wallet-owned  | Transactions |     8 | `SIGNED_PAYLOAD_MISMATCH`, `INTENT_EXPIRED`                                    |
| `GET /v1/transactions`                           | Authenticated | Transactions |     8 | `AUTH_REQUIRED`                                                                |

## Phase 1 endpoint schemas

### `GET /health`

Always reports process liveness and does not query MySQL. HTTP 200 when the HTTP process is serving.

### `GET /ready`

Queries MySQL and verifies that every local migration exists in `schema_migrations` with the expected checksum. HTTP 200 only when both checks pass; otherwise HTTP 503. It does not expose credentials, SQL, hostnames, or driver errors.

## Stable foundation error catalogue

| Code                   | HTTP | Meaning                                                    |
| ---------------------- | ---: | ---------------------------------------------------------- |
| `VALIDATION_ERROR`     |  400 | Input failed schema validation                             |
| `INVALID_QUERY_OPTION` |  400 | A non-allowlisted query option was supplied                |
| `CORS_ORIGIN_DENIED`   |  403 | Browser origin is not configured                           |
| `NOT_FOUND`            |  404 | Route/resource is unavailable or hidden by ownership rules |
| `RATE_LIMITED`         |  429 | Request limit exceeded                                     |
| `SERVICE_NOT_READY`    |  503 | Dependency/schema readiness failed                         |
| `INTERNAL_ERROR`       |  500 | Unexpected server failure; details remain internal         |

## Initial sequence diagrams

### Frontend wallet registration (Phase 3)

```text
Frontend               API                 MySQL
   | create keys locally |                    |
   | encrypt/store locally                    |
   |-- request challenge -->|                 |
   |<-- nonce + expiry ------|-- insert hash ->|
   | sign challenge locally |                 |
   |-- public data + proof ->|                 |
   |                        |-- lock/consume -->|
   |                        |-- verify proof   |
   |                        |-- insert account>|
   |<-- public account ------|                 |
```

### Quote to submission (Phases 6–8)

```text
Client -> API: quote request
API -> provider/RPC: route + balances + fee estimate
API -> MySQL: persist expiring quote
API -> Client: validated quote
Client -> API: create intent
API -> RPC: build/validate/simulate
API -> MySQL: persist exact unsigned intent
API -> Client: review + signing payload
Client: sign locally
Client -> API: signed payload
API: verify exact intent binding
API -> RPC: broadcast
API -> MySQL: record/reconcile status
```
