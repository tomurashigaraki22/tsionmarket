# Phase 0 Product Contract

## Approved implementation baseline

TsionMarket is a crypto **spot-market** product. It is not a prediction market, centralized matching engine, derivatives venue, or custodial wallet service. A scope change to any of those products requires a new domain and threat-model review before code is reused.

The initial backend responsibilities are authentication, user-to-public-wallet ownership, balances, market discovery, quotes, reviewed transaction intents, signed-payload validation/submission, reconciliation, and history.

The frontend is exclusively responsible for wallet generation/provisioning, secret storage/encryption, recovery material, unlocking, and signing. The backend must never request wallet secrets. It registers public account metadata only after verifying a short-lived ownership challenge signed by the wallet.

## Initial execution scope

- Order type: immediate spot swap only; no limit, stop, recurring, leveraged, or margin orders.
- Sides: exact-input buy and sell. Exact-output is deferred.
- Initial chain families: EVM and Solana, implemented one configured network/provider at a time.
- Baseline network candidates: Ethereum, Arbitrum, and Solana. Mainnet stays disabled until Phase 11 release gates pass.
- Baseline assets: native assets plus explicitly configured, verified tokens. Arbitrary client-provided token metadata is not trusted.
- Venues: provider adapters approved in configuration. Provider choice is server-controlled and normalized behind the quote contract.
- Regions: the API supports an explicit deployment allowlist/denylist. Legal/compliance approval is a release gate; this document makes no claim that any jurisdiction is approved.

## Authentication policy baseline

- Login identifier: case-normalized email.
- Password hashing: Argon2id plus an environment-injected pepper.
- Verification: one-time email challenge before financial operations.
- Access: short-lived signed access token, proposed lifetime 15 minutes.
- Refresh: opaque rotating token in an `HttpOnly`, `Secure` browser cookie, proposed idle lifetime 30 days and absolute lifetime 90 days.
- Recovery: one-time expiring email token; a successful password reset revokes all sessions.
- Client storage: access token held in memory where practical; refresh token is never exposed to JavaScript in the browser.
- Authentication implementation begins in Phase 2. Phase 1 contains only the production-safe bypass configuration guard.

## Product boundaries

Out of scope for Phases 0–1:

- User registration/login implementation.
- Wallet provisioning or key custody.
- Live chain adapters, balances, market providers, quoting, or execution.
- Mainnet activation.
- Fiat custody/on-ramp/off-ramp.
- Prediction-market resolution, order books, derivatives, or autonomous trading.

## Change control

Adding a chain, venue, order type, jurisdiction, custody behavior, or delegated signer requires updates to this contract, `api-contract.md`, `threat-model.md`, tests, configuration gates, and the implementation plan before release.
