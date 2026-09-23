# Phase 8–10 implementation status

## Phase 8 — submission, reconciliation, and history

- EVM submissions accept only serialized hexadecimal signed transactions. Signer, chain ID, nonce, destination, calldata, value, gas limit, and fee fields must exactly match the reviewed intent.
- Solana submissions accept only base64 versioned transactions. The serialized message must exactly match the reviewed message and every required signature is cryptographically verified.
- A deterministic transaction hash/signature and ledger row are committed with an atomic intent state transition before broadcast.
- A provider timeout after broadcast becomes `unknown`; it never triggers an automatic second broadcast. Reconciliation follows the already-known hash.
- Ledger uniqueness covers both intent and network/hash. Idempotent submission retries return the existing record.
- Reconciliation is bounded, restart-safe, exponentially backed off, and stops automatically at the configured attempt ceiling.
- Supported lifecycle classifications are `broadcasting`, `submitted`, `confirmed`, `failed`, `dropped`, `replaced`, `expired`, and `unknown`.
- Transaction summaries are copied into ledger records so cursor-based history requires no N+1 intent queries.

### APIs

- `POST /v1/transaction-intents/:intentId/submit`
- `GET /v1/transactions?limit=&cursor=`
- `GET /v1/transactions/:transactionId`

These endpoints accept signed public transaction bytes, not private keys, PINs, passphrases, decrypted wallet packages, or recovery material.

## Phase 9 — security and abuse controls

- Strict unknown-field rejection on signed-transaction submission.
- Global and route-specific rate limits for quotes, intent creation, and submission.
- Configurable signed-payload byte ceiling.
- Durable MySQL pause switches independently covering executable quotes, intent creation, and submission.
- Structured security events for rejected signatures and signed-payload mismatches.
- Ownership is part of every intent, record, and history SQL query.
- Production/staging startup requires a protected metrics token and rejects development authentication secrets.
- CI runs formatting, lint, type checking, tests, production build, dependency audit, and container build.

Independent security review, secret-scanner deployment, image scanning, and recorded findings remain mandatory Phase 11 release gates; application code cannot truthfully mark an external review complete.

## Phase 10 — observability and readiness

- Prometheus-text `/metrics` endpoint with production bearer protection.
- HTTP request count, status, and accumulated latency metrics.
- Structured logs retain request IDs and safe record/intent identifiers without signed payloads or secrets.
- Reconciliation backlog is queryable through the indexed lifecycle ledger.
- Schema and migration checksum verification remains available through `npm run db:verify`.
- Operational runbooks cover transaction recovery, provider outage, pause/resume, and incident response.

Docker/MySQL restore drills, alert-manager wiring, production dashboards, and RPC failover drill evidence require the deployment environment and remain release evidence rather than source-code claims.
