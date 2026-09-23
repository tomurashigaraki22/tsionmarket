# Phase 6 and Phase 7 implementation status

## LI.FI Portal attribution

TsionMarket deliberately differs from the Worldstreet reference by sending `integrator=tewa` on every LI.FI quote request. The identifier is configured with `LIFI_INTEGRATOR` and defaults to `tewa`; the older `worldstreet` identifier is not reused.

## Delivered

- Authenticated `POST /v1/quotes` for active catalogue markets and user-owned public accounts.
- Exact base-unit inputs only. Token addresses, direction, and decimals come from the server-side market record rather than the browser.
- LI.FI quote validation covering source amount, sender/recipient accounts, supported networks, slippage policy, output minimum, transaction presence, and price-impact policy.
- Immutable, short-lived quote snapshots stored in MySQL with request hashes and provider attribution.
- Authenticated `POST /v1/transaction-intents` using a persisted, unexpired quote rather than mutable client route data.
- Per-user idempotency keys and immutable unsigned-transaction hashes.
- EVM transaction reconstruction with a fresh pending nonce, gas estimate, current fee fields, destination/calldata/value checks, and `eth_call` simulation.
- Exact-amount ERC-20 allowance checks and separate approval intents. A swap is rebuilt only after the frontend signs/submits the approval and requests a fresh intent.
- Solana versioned-transaction decoding, fee-payer verification, and RPC simulation before returning serialized bytes to the frontend.
- Normalized human-review summaries containing provider, integrator, source token, destination token, exact sell amount, and minimum output.
- Frontend-only signing boundary: no private key, passphrase, PIN, decrypted DEK, or signed transaction is accepted by these Phase 6/7 creation APIs.

## State boundary

Phase 7 creates intents in `awaiting_approval` or `awaiting_signature`. Signed-transaction acceptance, broadcasting, receipt reconciliation, and final history belong to Phase 8 and are intentionally not implemented here.

## API examples

```json
POST /v1/quotes
{
  "marketId": "0x:ethereum-mainnet:base:quote",
  "side": "buy",
  "amountRaw": "1000000",
  "sourceAccountId": "uuid",
  "slippageBps": 50
}
```

```json
POST /v1/transaction-intents
{
  "quoteId": "uuid",
  "idempotencyKey": "stable-key-for-this-attempt"
}
```
