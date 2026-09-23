# Phase 12 implementation status

Phase 11 was deliberately skipped at product direction. That does not imply its production gates passed. Mainnet rollout evidence, independent review, backup/restore drills, provider contracts, and limited-funds canaries remain outstanding.

## Delivered

- Authenticated SSE transaction updates at `GET /v1/transactions/stream`.
- User ownership is applied inside every stream polling query. Connections heartbeat every five seconds and recycle after five minutes.
- Current portfolio valuation at `GET /v1/portfolio/valuation`.
- Historical valuation snapshots at `GET /v1/portfolio/valuation/history`.
- Each position includes raw balance, decimals, USD price, USD value, timestamp, and `spot_market_registry` provenance.
- Unpriced assets remain visible and are counted instead of being silently valued at zero.
- P&L explicitly reports unavailable until verified on-chain fills exist. LI.FI quote estimates are never misrepresented as execution prices.
- Chain adapter contracts support adding families without changing authentication, ownership, history, or valuation layers.
- Capability discovery at `GET /v1/capabilities` reports enabled adapters and disabled gated features.
- Session authority refuses registration unless the adapter is explicitly audited and carries an audit reference.
- Sponsorship refuses registration unless the provider is explicitly audited and carries an audit reference.
- Advanced orders remain disabled until a provider contract defines cancellation, partial fills, expiry, and settlement semantics.

## Intentionally unavailable

- No new chain was declared supported without a complete balance, intent, signature-validation, broadcast, reconciliation, and frontend signing implementation.
- No EOA transaction is described as gasless. EVM sponsorship requires an audited smart-account/paymaster design; Solana sponsorship requires an isolated sponsor signer and constrained relay.
- No delegated/session token is treated as chain authority.
- No realized or cost-basis P&L is calculated from quote estimates.
- No limit/stop order is accepted without durable cancellation and partial-fill reconciliation.

These are safety gates, not placeholders that silently fall back to unsafe execution.
