# OnSwitch Payments — Implementation Plan

- **Status:** Phases 1–5 backend code implemented; Phase 0 vendor/live-readiness confirmations remain open; frontend payment UI remains future work
- **Last reviewed:** 25 September 2026
- **Scope:** `tsionmarket` backend and `tsionmarket-frontend` only.
- **Provider docs:** [docs.onswitch.xyz](https://docs.onswitch.xyz/introduction)

## Repository and worktree check

- The backend `main` worktree is already aligned with `origin/main`; there are no other backend worktrees to merge.
- The frontend Claude branch `claude/tsionark-landing-plan-5345ac` is an ancestor of frontend `main`. Its changes are already present on `main`; there is no additional Claude diff to pull.
- The existing untracked `docs/SCRABBLE_IMPLEMENTATION_PLAN.md` is unrelated user work and must remain untouched.
- This document records the implementation plan and execution status. Backend quote/initiation journeys are in place for Phases 4–5; sandbox-to-live validation and payment UI remain future work. No provider credentials are stored here.

## Phase 0–5 execution update — 25 September 2026

### Phase 0: local product and provider contract

The docs-based product boundary and integration contract are now recorded here. The official introduction, authentication/sandbox pages, API reference/OpenAPI schema, coverage, assets, beneficiary, on/off-ramp, swap, status, and webhook docs were reviewed. Locally confirmed details:

| Area                | Confirmed from official docs                                                                                                                      | Still requires Switch/client confirmation                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authentication      | Server requests use `x-service-key`; sandbox and live keys are separate while API origin is the same.                                             | Confirm whether service keys can be scoped/rotated independently and the production onboarding process.                                                                        |
| Product scope       | Fiat on-ramp to stablecoin, stablecoin off-ramp to fiat, and stablecoin-to-stablecoin swap endpoints exist.                                       | Confirm commercial enablement and supported live corridors/assets for this TsionMarket partner account.                                                                        |
| Coverage and assets | `/coverage` and `/asset` expose current country/direction/channel/asset support and ramp/swap flags.                                              | Confirm the account's live limits, exact networks/token contracts, and which assets are enabled for our account.                                                               |
| On-ramp             | Initiation can name an external wallet beneficiary and returns payment instructions/status.                                                       | Confirm destination-credit timing/finality, exact amount/reference rules, expiries, and failure/refund treatment.                                                              |
| Off-ramp            | Initiation provides a stablecoin deposit amount/asset/address; `/payment/confirm` accepts the transaction hash for off-ramp deposit confirmation. | Confirm required confirmations, under/overpayment behavior, refund flow, payout reversals, and duplicate-reference handling.                                                   |
| Webhooks/status     | Docs specify HMAC-SHA256 over raw body, status lookup, callback retries, and payment statuses including `SCHEDULED`, `BLOCKED`, and `REVERSED`.   | Confirm sandbox signing/test-event procedure, replay/timestamp contract, callback delivery SLA, and escalation path.                                                           |
| Quotes and fees     | Quote endpoints return rate, fee, source/destination amounts, settlement estimate, and expiry.                                                    | Initiate schemas do not identify a quote ID; confirm quote lock/binding, rate changes at initiate, final fee behavior, and payout SLA before describing a quote as guaranteed. |
| Compliance          | Beneficiary requirements, payment reasons, and AML endpoints are documented.                                                                      | Confirm which party performs KYC/AML, what must be collected, retention/consent requirements, and approved launch jurisdictions with counsel/client.                           |

**Phase 0 is not cleared for live payments.** The local product scope is decided, but vendor answers, partner account configuration, compliance/legal approval, and corridor-specific live verification are external release gates. The previously shared credential should be rotated; no authenticated provider API request has been made with it.

### Phase 1: secure transport/configuration foundation

Implemented in this change:

- Server-only, fixed-origin OnSwitch client with a narrow endpoint allowlist; Switch wallet creation/export/transfer endpoints are deliberately excluded.
- Separate sandbox/live secret variables, default-disabled feature flag, selected-key validation, and hard guards against sandbox in production or live mode outside production.
- API key sent only as `x-service-key`; HTTPS origin cannot be overridden, redirects are rejected, request/response byte limits and bounded timeouts are enforced, and ambiguous provider errors are normalized without exposing provider response bodies or request data.
- Fixed-endpoint provider request counters and latency metrics; no query values, user IDs, PII, body, or credentials become metric labels.
- Docker Compose passes OnSwitch credentials only to the API container, not the migration job. Local/deploy templates keep the integration disabled and contain no key values.
- Environment and transport tests cover environment selection, key requirements, request construction, endpoint allowlisting, timeout, size limits, malformed/provider failures, safe errors, and metrics.

**Phase 1 acceptance:** The backend transport/configuration boundary is complete and defaults off. No actual Switch request is made until a rotated sandbox key is configured securely. Phase 1 does not add quote/initiation flows or UI; durable lifecycle and read-only capability APIs are implemented in Phases 2–3 below.

### Phase 2: durable lifecycle, signed callbacks, and reconciliation foundation

Implemented in this change:

- Added migrations for payment quote/operation records, per-user opaque beneficiary references, transition history, a digest-only webhook inbox, and provider catalogue cache. Payment rows are tied to their owner, wallet account, quote, beneficiary, and any linked confirmed transaction; linked wallet and transaction foreign keys enforce matching user ownership.
- Added HMAC-fingerprinted operation/idempotency primitives. Reusing a key with the same request returns the existing operation; reusing it with changed request material conflicts. Quotes are user-scoped, expiry-checked, locked before consumption, and consumed only when an operation is successfully inserted.
- Added a narrowly mounted public callback endpoint before JSON parsing. It verifies HMAC-SHA256 over exact raw request bytes with constant-time comparison, validates event shape/reference/type, stores only a digest and normalized metadata, and rejects unknown or mismatched local payment references. The unsigned timestamp header is diagnostic metadata only; event-digest deduplication is the replay defense.
- Added a bounded worker for inbox processing, off-ramp confirmation retries, provider status reconciliation, backoff, row locking, and manual-review ceilings. Callback and reconciliation transitions are idempotent and never credit balances.
- Added user-scoped payment history/detail repository reads.

**Phase 2 boundary:** Provider quote/initiation calls are now implemented in Phases 4–5. Provider reference/idempotency semantics still require sandbox confirmation; ambiguous initiation is recorded as unknown and queried by the supplied reference rather than blindly retried. Migrations have not been applied or integration-tested against MySQL in this local environment. Retention/deletion policy and any encryption required for future payment instructions remain release work.

### Phase 3: dynamic capabilities and beneficiary support foundation

Implemented in this change:

- Added authenticated, read-only endpoints for dynamic payment capabilities, beneficiary field requirements, institutions, account-name lookup, local saved-beneficiary references, and refresh of a user-owned provider beneficiary.
- Coverage, assets, requirements, institutions, and safe beneficiary-existence data are schema-validated and cached with bounded TTL plus `asOf`/`stale` metadata. Stale data can be displayed, but the operation-selection guard rejects it for new payment use.
- Provider assets are intersected with enabled networks, the user's active verified accounts, and TsionMarket's canonical token address/decimal registry. Provider names, symbols, IDs, contract addresses, and network IDs supplied by a client are not trusted for eligibility.
- Account lookup returns only a matched name, institution code, and last four account digits. Saved beneficiaries return a local ID and masked label; provider PII and raw responses are not exposed or cached.

**Phase 3 boundary:** Capabilities are not payment execution. The integration remains disabled by default, the previously exposed sandbox key must be rotated, and no authenticated provider request has been made. Database-backed API behaviour and migrations need a MySQL integration run before enabling the provider. Frontend payment UX remains a later phase.

## Product outcome

Add in-app, authenticated payment journeys for:

1. **Fiat to stablecoin:** a user pays using a supported local bank/mobile-money rail and receives a supported stablecoin at a verified address in their existing TsionMarket self-custodial wallet.
2. **Stablecoin to bank/mobile money:** a user requests a local-currency payout, reviews a quote, signs an on-chain stablecoin transfer from their wallet to the provider-issued, single-use deposit address, and tracks the payout to a terminal state.
3. **Fiat to other crypto:** compose the fiat-to-stablecoin journey with TsionMarket's existing spot-swap flow. The user first receives the stablecoin, then separately reviews and signs a normal on-chain swap. It is not an atomic or instant fiat-to-volatile-crypto conversion.

Existing direct wallet receive remains available: users can receive USDC from another wallet directly to their network address. That is a normal on-chain transfer, not an OnSwitch transaction. “Add funds” should distinguish **Receive crypto** from **Buy with bank/mobile money**.

## Verified provider capabilities and important limits

OnSwitch documents `POST /onramp/quote` and `/onramp/initiate` for local fiat to stablecoin, `/offramp/quote` and `/offramp/initiate` for stablecoin to local fiat, and `/swap/quote` and `/swap/initiate` for asset swaps. On-ramp initiation may return local payment instructions such as a one-time bank account; off-ramp and swap initiation return a deposit amount, asset, and address the user must fund. The documented payment statuses include `AWAITING_DEPOSIT`, `PROCESSING`, `COMPLETED`, and `FAILED`; webhook documentation also describes `REVERSED`, `SCHEDULED`, and `BLOCKED`.

The docs' supported asset catalogue is stablecoin-oriented (for example USDC/USDT on selected networks). **Do not advertise OnSwitch as a direct fiat-to-ETH/SOL/native-coin service based on these docs.** OnSwitch `/swap` is only exposed for assets/corridors it reports as supported; the planned first-party “buy other crypto” path is OnSwitch fiat→stablecoin followed by the existing TsionMarket spot router (currently LI.FI) as a distinct, user-approved transaction. A direct Switch stablecoin swap can be considered separately after sandbox verification.

Availability must come from OnSwitch `GET /coverage` and `GET /asset`, including the requested direction/channel and the asset's `onramp_supported`, `offramp_supported`, or `swap_supported` property. Do not hardcode country lists, banks, payout limits, or supported token/network combinations from examples in docs. Intertrain/WSK must remain unavailable for Switch payments unless the live provider catalogue explicitly reports a compatible asset and direction. Do not add bridging or wrap WSK to make it appear supported.

## Architecture decisions and non-negotiable invariants

1. **Preserve self-custody.** The existing wallet creates, encrypts, unlocks, and signs locally. Never use an OnSwitch-created wallet as a silent replacement, export or persist its private key, or send TsionMarket wallet secrets to the backend/provider. Use a user's verified external wallet address as the on-ramp destination and the user's locally signed transaction for on-ramp/Swap deposit-address funding.
2. **Keep provider credentials server-side.** OnSwitch's `x-service-key` authenticates API calls and the docs state it must be kept secret. The sandbox and live keys are separate even though the docs use the same API host. Load the correct key from deployment secrets (and a local ignored env file during development); never hardcode it in code, tracked examples, plans, logs, browser bundles, or requests made by the frontend. Sandbox key exposure should be treated as key exposure and rotated before continued use. The supplied credential is intentionally not reproduced here.
3. **Use a separate payment domain.** Bank pay-ins/payouts and Switch references are not generic wallet withdrawals or LI.FI swap transactions. Persist a provider payment record linked to (but separate from) the local transaction intent/chain transaction used to fund an off-ramp.
4. **User-owned addresses only.** Resolve the sending/receiving account from the authenticated user's verified wallet account records; derive the address server-side. Never trust a client-submitted source wallet address, provider deposit address, token contract, chain ID, or asset decimals.
5. **Provider-issued destinations are server-bound.** For off-ramp and provider swap deposit transfers, keep the address, network/asset, exact amount, and expiry from the provider response on the server. Create a scoped local signing intent from that persisted record; do not accept an arbitrary client-supplied destination when producing that intent.
6. **No false balances.** No local balance is credited when an on-ramp is initiated, a bank transfer is instructed, or a webhook is received. The self-custodial wallet's chain balance is authoritative. A payout is complete only when the provider reports terminal success and reconciliation agrees.
7. **Exact values.** Store and expose amounts as decimal strings/base-unit integers. Convert only at the Switch JSON boundary, whose OpenAPI schemas use JSON numbers; use exact decimal arithmetic and validate precision/range before serialization. Never do financial math with binary floating-point.
8. **Quotes and retries are explicit.** Persist the exact quote/terms and expiry. The documented initiate payloads do not expose a quote ID; confirm with Switch how quote expiry and execution pricing bind before claiming a locked quote. Give each local operation a server-generated UUID reference. Do not blindly retry an ambiguous initiate `POST`; mark it `unknown` and query status using that reference first. Confirm Switch's reference idempotency contract during vendor validation.
9. **Compliance still applies.** “In app” means the customer does not need a separate TsionMarket product to start the flow. It does not bypass provider onboarding, KYC/AML, bank rules, sanctions screening, regional eligibility, or payment-purpose fields. Only collect and send fields required by dynamic provider requirements and approved policy.
10. **No assumptions about fees or revenue.** Show the returned fee/rate/settlement data. Do not add `developer_fee` or a TsionMarket fee until product/commercial approval and transparent user-facing disclosure.

## Existing TsionMarket baseline

The checked code already provides useful primitives:

- Backend verified wallet ownership and network-specific balance reads: `src/portfolio/`.
- Server-built, user-signed on-chain intents for swaps and direct withdrawals: `src/trading/IntentService.ts`, `src/trading/WithdrawalIntentService.ts`, and `src/transactions/`.
- Persisted, idempotent transaction lifecycle and user-scoped history/SSE: migration `0005_transaction_lifecycle.sql` and `src/transactions/`.
- Authenticated wallet screen, local unlock/signing, direct receive, and direct wallet withdrawal: frontend `src/routes/app.wallet.tsx`, `src/components/app/wallet/`, and `src/lib/api/`.

No OnSwitch client, payment/bank-rail API, payment-intent persistence, or provider-webhook processing was found in the checked repositories. This plan adds those as new concepts rather than pretending a direct wallet transfer is a bank payout.

## Target journeys

### A. Add funds with bank/mobile money

1. User chooses **Buy with bank/mobile money**, country, currency/channel, stablecoin, and verified destination wallet account.
2. Backend loads current coverage/assets and applicable on-ramp requirements; it rejects unsupported combinations regardless of frontend state.
3. Backend obtains a quote and returns normalized source amount, expected stablecoin amount, rate, fees, expiry, channel, and settlement estimate.
4. User reviews and confirms. Backend creates one local payment operation and calls OnSwitch `/onramp/initiate` with the destination wallet beneficiary and a server-generated provider reference.
5. UI displays provider-supplied payment instructions (for example account name/number/bank, exact amount, note, and expiry) and a persistent status view.
6. Status changes through verified webhook and/or status polling. On completion, refresh wallet balances; do not create an internal spendable credit.

The user must be told that the payment instruction can be one-time and time-limited. A returned account number, exact amount, memo/note, or expiry must be rendered exactly as returned, with copy actions and clear expiration behavior.

### B. Withdraw stablecoin to bank/mobile money

1. User chooses **Cash out**, selects a verified account/network and a supported stablecoin balance, country/currency/channel, and a saved or new recipient.
2. Backend loads requirements/bank institutions dynamically, validates the beneficiary, and obtains an off-ramp quote.
3. User reviews the fiat payout amount, exact token amount/network, rate, fees, payout rail, expiry, and any required payment-purpose declaration.
4. Backend creates a local operation and calls `/offramp/initiate`. It stores Switch's reference and exact deposit instructions.
5. Backend creates a one-time, short-lived TsionMarket signing intent bound to the selected verified account and the provider's exact deposit address, asset/network, amount, and operation ID. The user unlocks locally, reviews, signs, and submits once.
6. After the chain transaction is confirmed, backend submits the transaction hash to `/payment/confirm` (the docs require the hash for off-ramp confirmation) and reconciles status.
7. UI tracks chain submission separately from fiat payout. A confirmed token transfer is not labelled “bank payout complete”; show `processing`, `scheduled`, `blocked`, `reversed`, failure, and recovery states honestly.

### C. Fiat to non-stablecoin crypto

1. On-ramp funds supported stablecoin to the user's verified wallet.
2. Once chain balance is observed, user selects **Swap** and chooses a supported spot market.
3. Existing TsionMarket quote/review and local signing flow executes the swap.
4. These are two linked but independently confirmed operations. No hidden auto-swap and no promise of atomic delivery. If the on-ramp succeeds but the spot swap fails or expires, the stablecoin remains in the user's wallet.

## Proposed backend surface (not an existing API contract)

All customer endpoints below are authenticated, user-scoped, strict-schema, rate-limited, and use the existing `{ success, data }` / error envelope. Names may be adjusted during Phase 0 API review.

| Proposed endpoint                                                      | Purpose                                                                                         |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `GET /v1/payments/capabilities`                                        | Normalized provider coverage, assets, directions, and channels with observation time/staleness. |
| `GET /v1/payments/requirements?direction=&country=&currency=&channel=` | Dynamic beneficiary/payer fields and institution options.                                       |
| `POST /v1/payments/onramp/quotes`                                      | Validate wallet, corridor, asset, amount and return a normalized quote.                         |
| `POST /v1/payments/onramps`                                            | Create a bank/mobile-money pay-in operation and return sanitized payment instructions.          |
| `POST /v1/payments/offramp/quotes`                                     | Validate source account/asset, corridor and amount; return payout quote.                        |
| `POST /v1/payments/offramps`                                           | Create provider payout operation and bind exact token deposit instructions.                     |
| `POST /v1/payments/:paymentId/transfer-intent`                         | Create the signed chain transfer for the exact persisted off-ramp destination.                  |
| `GET /v1/payments?limit=&cursor=` / `GET /v1/payments/:paymentId`      | Reloadable, user-scoped payment history and operation details.                                  |
| `POST /v1/providers/onswitch/webhook`                                  | Public callback receiver; accepts only raw requests with a valid Switch signature.              |

Potential future endpoints for Switch stablecoin-to-stablecoin conversion are not in the first release: add only after an explicit product decision and sandbox verification of exact supported assets, source funding semantics, refunds, and destination settlement.

## Proposed persistence and operation lifecycle

Add a migration for a provider-payment domain; exact table names and columns are finalized in Phase 1. At minimum persist:

- Local payment UUID, user ID, operation kind, normalized local status, provider name, provider reference, and timestamps.
- Verified wallet account association and canonical network/asset IDs where relevant.
- Exact decimal/base-unit source and destination amounts, fiat currency, rate, fees, channel, settlement estimate, quote expiry, and a sanitized quote snapshot.
- Idempotency key and request fingerprint, unique per user; unique provider/reference pair.
- Provider deposit instructions needed to resume after reload (for an on-ramp: exact pay-in details; for an off-ramp: exact chain/asset/amount/address/expiry). Encrypt sensitive fields at rest or avoid persisting what can be re-fetched; never store a service key.
- Provider beneficiary ID and minimal masked display metadata, not full bank/mobile-money account data, unless an approved encrypted-data-retention design requires it.
- Related TsionMarket transaction intent/record IDs and chain hash for off-ramp funding.
- A durable webhook inbox/event digest with enough metadata for dedupe/audit; avoid retaining full provider PII payloads unless explicitly required.

Use a local status machine broad enough to represent provider and chain stages, for example:

```text
created → quoted → initiating → awaiting_fiat → processing → completed
                                  └→ awaiting_chain → chain_submitted → processing ┘
Any nonterminal state → failed | expired | blocked | scheduled | reversed | unknown | manual_review
```

This is a product normalization, not a claim that the provider exposes every local state. Enforce allowed transitions and do not let delayed/duplicated callbacks move a terminal state backwards. Keep chain transfer status in the existing transaction ledger and link it to the payment record; do not collapse “chain confirmed” and “payout complete.”

## Phase-by-phase implementation

### Phase 0 — Product, vendor, and compliance contract

**Work**

- Confirm the first launch corridors and goals with the client. The proposed first corridor is Nigeria (NGN, bank) only if live/sandbox `/coverage` confirms both directions and product/legal approval exists; additional countries are data-driven later.
- Confirm with Switch: sandbox/live account provisioning, supported asset/network list and token contracts, supported on/off-ramp channels, on-ramp completion semantics, quote lock/expiry guarantees, reference idempotency, payout reversals/refunds, deposit under/overpayments, required confirmations, webhook retry behavior, account ownership/KYC/AML responsibilities, limits, fees, service availability, and support/escalation route.
- Confirm the intended crypto scope: fiat purchases land in a supported stablecoin first; volatile-asset acquisition is a separate TsionMarket spot swap. Do not scope native WSK or Intertrain into Switch until explicitly supported.
- Approve exactly which beneficiary fields/payment purposes are collected, how long records are retained, user disclosure text, support procedures, and whether beneficiaries are saved with Switch.
- Classify the disclosed sandbox credential as exposed and rotate it in the provider dashboard. Use a fresh sandbox secret for testing; keep live credentials separate.

**Deliverables**

- Reviewed corridor/asset matrix and payment data-flow diagram.
- Vendor answers recorded for quote binding, initiation retry safety, status lookup, payout/reversal, exact deposit amount/address semantics, and sandbox behavior.
- Approved KYC/AML, privacy, jurisdiction, fees, and risk boundaries.

**Acceptance gate**

- No production transaction enabled until Switch confirms operational and legal requirements, live coverage, exact funding/refund behaviors, and the supported stablecoin contracts/networks.
- Product copy does not promise direct native-crypto payout, atomic fiat-to-crypto, Switch custody of TsionMarket keys, or unsupported WSK/Intertrain.

### Phase 1 — Secure OnSwitch backend adapter and configuration

**Work**

- Add typed `OnSwitchClient` / provider adapter with a fixed HTTPS host, bounded connect/request timeout, response schema validation, response-size limits, sanitized errors, and provider-specific rate controls.
- Send the service credential only in `x-service-key` from the backend. Select sandbox/live mode from server configuration; although docs use the same API base URL, use distinct secrets and distinct feature gates. Do not permit a frontend-supplied base URL, API key, or mode.
- Add empty variable names/placeholders to `.env.example` only (no value): provider enabled flag, environment (`sandbox`/`live`), server secret variable, timeout/cache configuration, and public callback URL if needed. Production startup must fail closed when enabled without correct configuration. Keep all actual values in ignored local env/deployment secret manager.
- Make provider-disabled mode the default. The app should start and unrelated wallet/spot behavior should keep working without a key.
- Normalize Switch's response wrapper and preserve the vendor reference/request ID in safe logs. Redact API keys, beneficiary inputs, bank account details, deposit instructions, and raw webhook bodies.
- Add metrics for request latency/error class/endpoint and provider status age; never include user PII or credential values as labels.

**Tests / acceptance**

- Unit tests cover URL restriction, header placement, timeout, malformed JSON/schema, provider error mapping, 429/5xx handling, and redaction.
- Test confirms the key cannot enter browser-facing API responses, client bundles, logs, or tracked fixtures.
- Sandbox/live settings cannot accidentally use the wrong configured secret; provider integration remains unavailable when disabled.

### Phase 2 — Durable payment model, idempotency, callbacks, and reconciliation

**Work**

- Add schema for payment operations, quotes/snapshots, beneficiary references, and webhook inbox records with foreign keys, uniqueness, indexed user history, and retention policy.
- Create server-owned payment operation IDs and idempotency keys. Fingerprint all material fields so a retry with the same key returns the same operation while changed amounts/accounts/corridors are rejected.
- Treat quote/create `POST` timeouts as ambiguous. Use provider `reference` only after confirming how Switch handles duplicate references; query `/payment/status` before any retry. No blind duplicate on-ramp/off-ramp creation.
- Verify callback HMAC-SHA256 over the exact raw request bytes using the server-held service key for the selected environment, timing-safe compare, reject missing/invalid signatures, and apply a configured replay window only where timestamp semantics allow. Because the documented signature covers the body, store idempotency/digest to neutralize replays even when timestamp cannot be trusted as signed.
- Mount a narrowly scoped raw-body callback handler before JSON parsing or use route-specific raw parsing; do not weaken the parser or public access rules for other `/v1` routes.
- Persist verified callback metadata before returning 2xx. Process asynchronously/idempotently; verify provider reference belongs to the local payment. Use `payment/status` to reconcile critical transitions and resolve gaps, stale callbacks, and ambiguous initiation outcomes.
- Add a bounded worker/backoff for stale nonterminal operations, status polling, confirmation retries, and manual-review ceiling. Preserve terminal states and record sanitized state-transition history.

**Tests / acceptance**

- Exact raw-body signature validation, malformed signature, timing-safe compare, replay, duplicate callback, cross-user/nonexistent reference, out-of-order state, simultaneous webhook/poller, worker restart, provider timeout, and reconciliation exhaustion tests.
- A webhook cannot mark a user's wallet balance credited or complete an on-chain transfer by itself.
- An initiate timeout produces a recoverable `unknown` state and never silently creates a second provider payment.

### Phase 3 — Dynamic coverage, supported assets, and beneficiary requirements

**Work**

- Fetch and cache `/coverage`, `/asset`, `/beneficiary/requirement`, `/beneficiary/fetch`, `/institution`, and `/institution/lookup` through the adapter. Cache with bounded TTL; expose `asOf`/staleness; fail closed for creating new payment operations when required catalogue data is unavailable/stale.
- Intersect provider data with TsionMarket's enabled networks, canonical token registry, balance/read support, and active locally verified wallet accounts. Translate provider asset IDs (for example `arbitrum:usdc`) into trusted internal asset/network IDs using explicit allowlisted mappings; never trust a symbol/name/contract from a client.
- Load field requirements and regex/examples for each direction, country, currency, channel, and holder type. Render only required, validated beneficiary/payer fields. Use institution lookup for bank selection/account-name resolution if the live API confirms it.
- Prefer provider-side saved beneficiary IDs so TsionMarket stores only an opaque provider reference and masked label. If full bank details must be retained locally, stop and add a reviewed authenticated encryption/key-rotation/deletion design before proceeding.
- Return safe, normalized capability data to the frontend; do not proxy raw provider responses.

**Tests / acceptance**

- Dynamic catalogue test fixtures; unsupported asset, unsupported country/direction/channel, stale catalogue, wrong network mapping, disabled Tsion network, malformed requirements, and beneficiary regex tests.
- Only provider capabilities actually returned and allowed by TsionMarket are actionable in UI and API.

### Phase 4 — Fiat on-ramp (bank/mobile money → stablecoin)

**Execution status — backend implemented; provider sandbox verification pending.** Authenticated quote, initiate, detail, and refresh routes are wired into the backend. The route derives the destination from the selected verified account, saves exact quote terms with a short expiry, re-quotes before initiation, returns a sanitized payment-instruction view, and uses a generated UUID reference. Mobile-money payer and dynamic beneficiary fields are checked against provider requirements. Retried idempotency keys return the stored operation instead of repeating the provider POST; ambiguous responses are stored as unknown and reconciled. The backend never credits wallet or trading balances.

The implementation intentionally sends only the documented external-wallet beneficiary form and does not send the customer's account address as a client-provided destination. Provider instructions and safe quote data are persisted; beneficiary/payer form values are not stored in the operation. Quote JSON numbers are converted from exact decimal strings only after precision checks.

**Work**

- Implement quote and initiate service/routes using `/onramp/quote` and `/onramp/initiate` with server-validated local fiat amount, country/currency/channel, stablecoin asset, and verified destination wallet account.
- Convert account selection into the verified user's address; submit the documented external-wallet beneficiary (`holder_type`, `holder_name`, `wallet_address`) or provider saved beneficiary form as appropriate. Never accept a free-form destination address for an unauthenticated or unverified wallet.
- Persist quote terms and expiry. Since the docs show no quote ID in initiate, revalidate required terms immediately before creating; if expired or changed, require the user to review a new quote. Do not advertise a fixed rate unless Switch guarantees it.
- Persist the on-ramp result and return only the fields needed for the user to pay: exact bank/mobile-money instructions, fiat amount, currency, reference/note, expiry, destination stablecoin and wallet, and current normalized status.
- Add an authenticated payment details/status view with copy-to-clipboard, expiry, refresh, provider status, and “funds appear after settlement” language. On final provider status, refresh chain balances; reconcile a supplied chain hash when documented/available.
- Keep direct address receive as a separate action and keep Switch payment completely out of spot market balance credits/arcade ledger.

**Tests / acceptance**

- Sandbox cases: quote, exact-input and exact-output where supported, expired quote, bank instructions, mobile-money payer details when supported, provider rejection, duplicate initiate, callback/status completion, reload, failed/expired/blocked states.
- Wrong account/network, unverified address, unsupported stablecoin/corridor, altered amount, and user A fetching user B's payment are rejected.
- No spendable balance or `COMPLETED` UI state is synthesized from just `AWAITING_DEPOSIT`/`PROCESSING`.

**Local verification:** journey and lifecycle unit tests cover verified-wallet derivation, strict address-input rejection, status direction mapping, and on-ramp instruction persistence. A real provider sandbox journey, MySQL migration/integration test, and the frontend payment display are not verified in this environment.

### Phase 5 — Fiat off-ramp (stablecoin → bank/mobile money)

**Execution status — backend implemented; provider sandbox verification pending.** Authenticated quote/initiate/refresh endpoints validate dynamic payout requirements and user-owned saved beneficiaries. The operation is bound to a verified account, canonical network/token metadata, the provider quote, and a request fingerprint. Off-ramp initiation persists only a curated allowlist of one-time deposit instructions; its expiry is taken from the provider or conservatively derived from an explicit duration in its note. If no safe expiry is available, the transfer-intent endpoint refuses to create a spendable action.

`POST /payments/:paymentId/transfer-intents` accepts only an idempotency key. The server loads the payment and constructs a dedicated `payment_transfer` intent from the persisted provider address, exact amount, asset, account, expiry, gas/balance checks, and local chain adapter. A worker binds the intent to its confirmed transaction and then queues `/payment/confirm`; provider payout completion remains separate from chain confirmation.

**Work**

- Implement `/offramp/quote` and `/offramp/initiate`, using dynamic beneficiary requirements and bank/mobile-money lookups. Include required sender name, narration, payment purpose, refund address, or other fields only as the corridor requires.
- Tie the quote to a verified wallet account, trusted token contract/network, exact raw token amount, currency, destination beneficiary, channel, terms, and expiry. Ensure the selected account has sufficient chain balance and the supported asset has enough precision.
- After initiate returns Switch `reference`, `deposit.amount`, `deposit.asset`, `deposit.address`, `deposit.note`, and expiry, persist and display the provider's instructions. Show the route/network and warn that sending a wrong asset/network or amount may delay or lose funds.
- Add a dedicated server-created payment transfer intent. Resolve its account from the local payment record, use only the persisted provider deposit address and asset, enforce exact provider amount/decimals and expiry, estimate native gas, and bind operation ID/reference into the immutable summary and idempotency fingerprint.
- Reuse the established local wallet unlock/sign/submit experience, but label it as **Send USDC to cash out** with the destination explicitly identified as Switch's one-time deposit address. Preserve typed chain transaction states; do not alter generic direct-wallet withdrawal semantics.
- After the chain transaction is confirmed, call `/payment/confirm` with Switch reference and confirmed transaction hash where required. Track provider payout to completed/failed/reversed/scheduled/blocked, and show actionable support/reference information.

**Tests / acceptance**

- Sandbox full off-ramp journey from quote to signed chain transfer to provider confirmation/status, including insufficient token/gas balance, expiry, wrong chain, token-decimal mismatch, provider address substitution attempt, resubmission, provider delay, and payout reversal/failure.
- The browser cannot change the receiving address/asset/amount after the server creates the payment transfer intent.
- Chain confirmation is reported as “transfer sent/confirmed,” never as “bank payout complete” until provider reconciliation succeeds.

**Local verification:** unit tests cover quote/initiation persistence and prove the transfer intent receives its amount, recipient, and token only from the server-stored provider instructions. Full signed-chain, provider confirmation, MySQL migration, and sandbox payout testing remain outstanding.

### Phase 6 — Buy volatile crypto with fiat and optional stablecoin swaps

**Execution status — implemented locally; Switch sandbox verification pending.** A completed on-ramp can be linked to the existing spot quote flow as a distinct, optional trade. The backend verifies that the payment belongs to the signed-in user and selected verified account, is completed, and matches the market's network and exact quote-token contract before persisting the relation; the database enforces same-user ownership. The Wallet activity action also refreshes the live chain balance and requires the original account to remain locally controlled before opening Trade. Switch's separate `/swap` endpoints are not used.

**Work**

- Build a composed journey: on-ramp into supported USDC/USDT; wait until the stablecoin is observable and spendable; then offer a link to the existing spot-swap quote flow for target asset.
- Link the local payment ID to the later spot quote/intent for activity context but preserve separate risk, expiry, slippage, approval, signature, and failure status.
- If users leave before swapping, funds stay in their wallet. If the swap fails/quote expires, show the remaining stablecoin, not a failed “fiat purchase.”
- Evaluate Switch `/swap/quote` and `/swap/initiate` only for provider assets where `swap_supported=true`. Treat its one-time deposit-address funding as a separate transfer intent and include it only after sandbox and vendor settlement/refund rules are verified. Do not use it for volatile tokens absent explicit capability.

**Tests / acceptance**

- Successful on-ramp without swap, delayed on-ramp, swap quote expiry, insufficient balance/gas, swap failure, and retry cases leave accurate independent records and wallet balances.
- Copy and UI describe fiat-to-stablecoin plus optional spot swap as separate steps—not instant, guaranteed, or atomic.

### Phase 7 — Wallet UI, activity, and communication

**Execution status — implemented locally; Switch sandbox and responsive-browser QA pending.** Wallet now has distinct in-app **Add funds** and **Cash out** entry points, dynamic corridor/asset/requirement-driven forms, quote/review states, resumable provider instructions and status history. On-ramp settlement does not imply spendable funds: the UI refreshes the chain balance before offering the separate spot-trade step. Cash-out uses the server-created, payment-bound transfer intent and the existing local unlock/sign/submit flow. The payment modal uses a landscape desktop review and a scrollable mobile sheet with a fixed action footer. No claim is made that the provider is enabled or verified against sandbox in this environment.

**Work**

- In Wallet, add clear **Add funds** and **Cash out** entry points while retaining existing **Receive** and **Send**. Add a chooser that distinguishes bank/mobile-money fiat from on-chain crypto.
- Use dynamic supported corridors/assets, provider requirements, bounds, estimates, fees, and expiry. Keep all amounts/rates clearly denominated. Preserve accessible form labels, error/help text, copy controls, keyboard navigation, focus management, and reduced-motion behavior.
- Desktop: use a landscape transaction review layout consistent with the existing wallet withdraw modal. Mobile: use a clipped bottom sheet with a fixed action footer and scrollable content, preserving safe-area spacing.
- On-ramp details screen: prioritized exact pay-to instructions, account name, amount/currency, reference, expiry countdown, stablecoin destination, status and refresh/copy controls.
- Off-ramp review: amount sent, minimum/expected fiat received, exchange rate, provider fee, selected recipient masked, network fee (or “not available” rather than fabricated), one-time destination network/address, expiry, and a single explicit sign/send action.
- Add payment operations to Wallet/Activity with provider status and chain status side by side, user-safe reference, explorer hash when available, and support path. Keep sensitive bank details hidden after use and never show the full recipient account in broad history.
- Present localized support/terms copy only for currently enabled corridors. Be transparent that payment processing is provided by Switch and can require its compliance checks.

**Tests / acceptance**

- Responsive desktop/mobile layout; long beneficiary form scrolling; fixed mobile footer; focus/keyboard/screen-reader behavior; reload/resume; offline; slow provider; empty/partial catalogue; no fake rate/fee/status.
- Direct Receive and Send continue to work when OnSwitch is disabled or unavailable.

### Phase 8 — Security, abuse controls, and privacy review

**Work**

- Threat-model API-key compromise, webhook forgery/replay, IDOR, beneficiary manipulation, payment initiation abuse, duplicate payments, quote staleness, amount precision, callback flooding, provider outage, destination substitution, and partial completion.
- Apply auth ownership checks to every operation, strict unknown-field schemas, per-user + per-IP route limits, amount/corridor limits, maximum pending operations, suspicious retry controls, and durable audit events.
- Restrict outbound provider requests to HTTPS and the approved OnSwitch origin. Prevent SSRF by never accepting callback URLs or provider URLs from clients; configure a single callback URL server-side.
- Keep secrets out of frontend env/build args/source maps, logs, crash reporting, test fixtures, docs, `.env.example` values, and Git history. Use deployment secrets, rotation procedure, least-privileged sandbox/live credentials where offered, and a leak scanner.
- Encrypt retained PII/instructions as required; define deletion, retention, access logging, operator support controls, and database backup handling. Do not copy provider service key into the webhook inbox or transaction record.
- Review terms/disclosures with legal/compliance and confirm whether AML screening is automatic or requires explicit calls to Switch compliance endpoints.

**Tests / acceptance**

- IDOR, malformed/signed webhook, replay/dedupe, unauthorized beneficiary IDs, wrong wallet owner, amount/currency tampering, expired operation, provider-origin restrictions, rate limits, and secret/PII-redaction tests.
- Security review findings are closed or explicitly accepted before live payments are enabled.

### Phase 9 — Sandbox end-to-end verification and operations

**Work**

- Exercise sandbox end to end with a test user and a dedicated test wallet. OnSwitch docs describe sandbox transactions as simulated; treat test completions as test records, never real funds.
- Verify sandbox behaviors against docs and direct vendor answers for user bank instructions, stablecoin destination, off-ramp deposit address, supported asset network, exact amounts, errors, callback signatures, retries, status lookup, and reference idempotency.
- Add runbooks for: pending user payment, bank transfer expired, chain transfer confirmed but provider pending, callback outage, provider API outage, failed/reversed/blocked/scheduled payouts, unknown initiation timeout, reconciliation manual review, customer support, and safe key rotation.
- Add alerts/dashboards for provider health, webhook verification failures, pending age/backlog, quote-to-initiate failures, operation outcomes, reconciler lag, and paid-but-uncredited/credited-but-not-final states.
- Add provider pause control for starting new on/off-ramps independently; do not interrupt status lookup/reconciliation for existing operations when new initiation is paused.

**Tests / acceptance**

- Backend CI includes unit/integration/API contract, migration up/verify, production build, lint/typecheck, dependency and secret checks; frontend CI includes API contract tests, UX state tests, accessibility smoke tests, and production build.
- A test operation can be resumed after browser reload and backend restart with no duplicate debit, internal ledger credit, or lost reference.
- Operational owner, support escalation, callback endpoint, alert receiver, and reconciliation responsibility are assigned before production approval.

### Phase 10 — Limited live rollout and expansion

**Work**

- Provision separate production key only after Switch onboarding/contract/compliance approval, key rotation, sandbox pass, and security review.
- Deploy callback endpoint over HTTPS, configure exact server-owned URL at provider, validate signature against a harmless test event, and verify provider allowlisting if available.
- Start with provider disabled, then enable for staff/test wallets and one approved corridor/asset at strict limits. Reconcile every transaction against Switch history/status and the independent chain before increasing limits.
- Use a per-direction/per-corridor feature flag and global pause. Keep quotes and payment status readable for existing operations while new starts are disabled.
- Expand only based on measured reliability, settlement times, support load, loss/reversal rates, audit reconciliation, and provider approval. Add countries/assets through live catalogue and repeated corridor-specific signoff—not code assumptions.

**Acceptance gate**

- No live enablement until all previous phase gates, provider production readiness, database backup/restore test, monitoring, runbooks, support owner, and rollback/pause drill are recorded.
- Daily settlement reconciliation matches local operation records, provider history, and chain observations; exceptions stop new starts and enter manual review.

## Cross-cutting completion criteria

- A user can add supported stablecoin through bank/mobile money, reload the pending instruction/status, and see chain balance only once it is actually present.
- A user can cash out a supported stablecoin through local signing, follow chain and payout stages separately, and recover the same operation after reload.
- A user can choose to convert received stablecoin to other supported spot assets only through a separately quoted and signed transaction.
- No unsupported country, asset, network, bank rail, or feature is represented as available. No provider key, wallet secret, or unnecessary bank details reach the browser or logs.
- Duplicate requests, delayed/out-of-order callbacks, ambiguous provider timeouts, repeated submissions, and server restarts do not create duplicate transfers or false completion.
- Existing direct wallet receive, direct wallet send, spot, portfolio valuation, and Intertrain native WSK functionality remain independent and continue working with Switch disabled.

## Official documentation reference set

Re-read current official docs during implementation; endpoint schemas and coverage can change.

- [Introduction](https://docs.onswitch.xyz/introduction)
- [Authentication](https://docs.onswitch.xyz/authentication)
- [Sandbox](https://docs.onswitch.xyz/sandbox)
- [On-ramp quote](https://docs.onswitch.xyz/api-reference/onramp/get-quote)
- [On-ramp initiate](https://docs.onswitch.xyz/api-reference/onramp/initiate)
- [Off-ramp quote](https://docs.onswitch.xyz/api-reference/offramp/get-quote)
- [Off-ramp initiate](https://docs.onswitch.xyz/api-reference/offramp/initiate)
- [Stablecoin swap initiate](https://docs.onswitch.xyz/api-reference/swap/initiate)
- [Coverage](https://docs.onswitch.xyz/api-reference/miscellaneous/get-coverage)
- [Asset catalogue](https://docs.onswitch.xyz/api-reference/miscellaneous/get-assets)
- [Beneficiary requirements](https://docs.onswitch.xyz/api-reference/beneficiary/get-requirements)
- [Beneficiary creation](https://docs.onswitch.xyz/api-reference/beneficiary/create-beneficiary)
- [Payment confirmation](https://docs.onswitch.xyz/api-reference/payment/confirm-deposit)
- [Payment status](https://docs.onswitch.xyz/api-reference/payment/get-status)
- [Webhooks](https://docs.onswitch.xyz/webhook)
- [Stablecoin-to-NGN guide](https://docs.onswitch.xyz/guides/stablecoin-to-ngn)
