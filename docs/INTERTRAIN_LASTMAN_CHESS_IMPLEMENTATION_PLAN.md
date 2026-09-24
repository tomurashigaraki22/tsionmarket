# Intertrain, Last Man, and Chess — Implementation Plan

**Status:** TsionMarket implementation plan, 24 September 2026
**Scope:** TsionMarket backend and TsionMarket frontend only. Dashboard Revamp and WorldStreet Crypto Backend are read-only references for the Arbitrum bridge path.
**Important:** The selected product route is Arbitrum One native USDC → native Intertrain WSK. The separate Ethereum USDC → wUSDC lane is explicitly out of scope and must remain unchanged.

## Phase 2–5 execution update

- **Phase 2 — implemented:** the frontend derives a domain-separated Intertrain Ed25519 account from the existing recovery seed, adds it without changing existing encrypted account records, migrates old wallets on unlock/backup import, and lets users explicitly select among unregistered Intertrain addresses.
- **Phase 3 — fail-closed status only:** the Arbitrum `depositForWSK` contract is deployed, but the reviewed sources do not establish an independently verifiable event-to-native-WSK credit worker. TsionMarket exposes the exact Arbitrum USDC → WSK route and why settlement is pending; it does not create deposit intents or claim that an Arbitrum receipt is spendable WSK. No wUSDC path was added.
- **Phases 4–5 — implemented for read-only balances:** the backend reads native six-decimal WSK through Intertrain `chain_info` and `account_get`, keeps it separate from Arbitrum USDC, and only applies $1 valuation when the live reserve state is unpaused, 1:1, and fully collateralized. An Intertrain RPC failure remains isolated from Arbitrum balances.
- **Verification:** backend and frontend typechecks, targeted lint, full test suites, and production builds pass. Read-only mainnet RPC checks confirmed `intertrain-1`, native WSK, and the current 1:1 unpaused/collateralized reserve snapshot.

## Target outcome

- Make Last Man understandable to a first-time player: rule, round state, deadline, stake, and next action.
- Replace the Intertrain username-purchase promotion with an honest “Coming soon” state.
- Make Intertrain a coherent part of the wallet and portfolio, showing native WSK and Arbitrum USDC as distinct holdings.
- Integrate only the Arbitrum USDC → native WSK path, with a verifiable pending-to-credited lifecycle.
- Build chess with real chess pieces, server-validated play, signed-in invite links, and safe, explicit stake handling.

The requested accounting model is:

| Asset / stage    | Meaning                                                                | Portfolio treatment                                                              |
| ---------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Arbitrum USDC    | User’s source-chain token                                              | Arbitrum USDC balance; decrease only when its transaction confirms               |
| Intertrain WSK   | Native Intertrain asset, six decimals                                  | Native balance; value at $1 only when live collateral/reserve policy supports it |
| Bridge in flight | Arbitrum source transaction or destination WSK credit not yet verified | Pending activity, not spendable and never double-counted                         |

**Target:** Arbitrum USDC → native Intertrain WSK via the deployed `depositForWSK` route. The user-facing operation must not promise completion until the source deposit and destination WSK credit are independently verified. Do not mint, credit, display, or route wUSDC as part of this work.

## What I checked locally

### There are three different Intertrain paths

1. **Dashboard’s current product bridge is Arbitrum USDC → WSK.**
   In `dashboard-revamp/components/bridge/intertrain-usdc-bridge-client.tsx`, the source is Arbitrum One and the destination is called WSK. `worldstreet-crypto-backend/src/api/routes/intertrainBridge.ts` prepares approval and `depositForWSK(amount, destination)` intents. The source token configured in the backend is Arbitrum native USDC, `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`; its configured contract is `0x0729F81ACc0948089B0BAcc0685c461F8F54F23B`. Read-only Arbitrum RPC checks found bytecode at that address and `paused()` returned false. The local ABI/UI describe a WSK path, not a wUSDC mint.

2. **Intertrain’s live asset/bridge registry exposes a separate Ethereum USDC → wUSDC lane.**
   A read-only request to the live Intertrain RPC returned native WSK (WorldStreet Kash, six decimals). Its `asset_list` exposes wrapped USDC as `ethereum:USDC:mainnet:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, and `bridge_status` reports the Ethereum mainnet bridge `0x981fA35883e60Fbe229D449334B3507997af84E1` enabled. It did not list an Arbitrum wUSDC lane. The Ethereum bridge address also returned non-empty bytecode from a read-only RPC check.

3. **Native WSK has its own reserve/valuation path.**
   At inspection time, `mna_reserve_status` reported a collateralized reserve and a 1 USDC = 1 WSK rate. That is distinct from wUSDC issuance. Live `chain_info` and `asset_list` use WSK, superseding older devnet MNA wording in parts of the chain repository.

### Gaps and stale descriptions

- Arbitrum contract code is deployed and it is not paused, but local source/config does not prove that deposits are finalized and credited to the intended Intertrain account. Dashboard copy says WSK will appear; the status route checks configuration and Arbitrum `paused()`, but not Intertrain’s active lane or reserve status.
- The current Arbitrum flow encodes an `mna1…` destination in `depositForWSK`. It is not locally described as wUSDC. Do not relabel it as wUSDC or count one deposit as both wUSDC and WSK.
- `worldstreet-crypto-backend/src/config/intertrainBridge.ts` gates the route on mainnet/release/relayer flags. That status is not proof a mint relayer is healthy. The backend prepares signed intents; no Arbitrum-to-Intertrain mint worker was found in its local source.
- The backend’s code defaults keep mainnet/release/relayer approval off. Production runtime flag values were not inspected; no server environment or secret file was read.
- The current bridge intent builder approves `maxUint256` when allowance is insufficient. Use an exact-amount approval for this route; do not broaden token allowance as a side effect of this integration.
- `worldstreet-chain/mainnet/docker-compose.yml` configures the Ethereum USDC lane; its `ops/wsc-relayer.py` is wired around the configured source. The live Intertrain `bridge_status` and `asset_list` report Ethereum USDC as the active wUSDC lane. Arbitrum is accepted by some chain namespace validation, but is not the active wUSDC lane in the inspected mainnet response.
- Stale copy exists in `dashboard-revamp/docs/INTERTRAIN_PHASES_8_12.md` and `worldstreet-chain/web-next/lib/chain.js` claiming the mainnet bridge is not deployed. That conflicts with the configured addresses and live code/chain status.
- Dashboard’s Add Intertrain flow says it creates a separate account. `dashboard-revamp/lib/crypto-wallet/key-generation.ts` generates a random Ed25519 seed for Intertrain, while EVM uses another key family. This does not implement deriving Intertrain from the same wallet recovery material.
- The current bridge UI uses timer-based approval progression and does not persist/resume one end-to-end operation after reload. History reads transaction records; it does not prove that the Intertrain mint landed.

### Selected bridge path

Proceed with **Arbitrum One native USDC → native Intertrain WSK** only. The Arbitrum contract is configured as `0x0729F81ACc0948089B0BAcc0685c461F8F54F23B` and its ABI is `depositForWSK(uint256,string)`. Preserve the deployed contract and its destination semantics. Before enabling production deposits, independently verify its source/events and the external watcher/relayer that observes deposits and credits WSK on Intertrain. Bytecode presence and `paused() === false` do not prove that a destination credit worker is live.

The Ethereum USDC → wUSDC bridge, its `0x981f…` lane, wUSDC asset IDs, and all wUSDC mint/credit logic are not part of this work. Do not change, enable, disable, relabel, or migrate that lane.

## Invariants

1. The selected destination is native WSK only. Do not create or credit wUSDC in this route.
2. An Arbitrum transfer is not complete when the wallet returns a transaction hash. Completion requires source confirmation, destination processing, and verified Intertrain WSK balance/operation evidence.
3. Preserve encrypted wallet packages, backups, and funded addresses. No silent rekey or address replacement.
4. Derive Intertrain Ed25519 identity from the same recoverable wallet root using a versioned, domain-separated path—not from a public 0x address and not by reusing an EVM private key as an Ed25519 seed.
5. Users sign locally. Backend prepares/validates intents and reads status; operator credentials remain only in relayer infrastructure.
6. Use canonical asset IDs and integer base units. No floating-point bridge, conversion, stake, or payout math.
7. Show WSK at $1 only when live reserve/collateral state and approved policy support it; otherwise show stale/unavailable/degraded valuation honestly.
8. Game outcomes and stake movements are server-authoritative and idempotent.

## Phases

### Phase 0 — Arbitrum USDC → native WSK integration contract

**Work**

- Publish a versioned route record for Arbitrum One (42161), native USDC at `0xaf88…e5831` (6 decimals), the deployed `depositForWSK(uint256,string)` contract, Intertrain protocol `intertrain-1`, native WSK (6 decimals), and the required `mna1…` destination format.
- Verify contract source/immutability, emitted deposit event fields, destination binding, owner/relayer privileges, pause/replay controls, and exact WSK credit semantics. Local ABI and deployed bytecode are not proof of successful destination settlement.
- Identify the production Arbitrum event watcher/relayer, its confirmation threshold, idempotency key, retry/reconciliation path, and operator health signal. If that worker is external to the checked repos, record its owner and evidence before allowing production deposits.
- Define the operation state machine: intent → approval (only exact amount, if needed) → source submitted → source confirmed → destination processing → WSK credit verified; distinguish delayed, failed, and manually reconcilable operations.
- Confirm that destination verification can tie the source deposit ID and requested `mna1…` address to the resulting native WSK credit. A source receipt alone must remain pending.
- Keep the current release flags closed until the complete route and external settlement worker are verified. Do not read, copy, or modify production secrets as part of this phase.

**Acceptance**

- Contract and destination-credit responsibilities are evidenced, not inferred from bytecode presence or a healthy source RPC.
- The selected route is explicitly Arbitrum USDC → native WSK; wUSDC is not part of its API/UI promise or credit path.
- Settlement can be independently verified at the requested Intertrain account; otherwise the operation stays pending/unavailable.
- Approval is bounded to the requested amount and production remains gated until the settlement worker is verified.

### Phase 1 — Last Man redesign and Intertrain ID “Coming soon”

- Rebuild Last Man around the one-step loop: choose one of two sides; smaller side survives; larger side is eliminated; missing the deadline eliminates the player.
- Put current round, player status, deadline, choice, and primary action together. Use a small visual example; explain ties/repeats and minimum players in plain language.
- Separate rules, limits, entry terms, live round, and history. Keep technical IDs secondary and copyable only when useful.
- Before joining, show the round’s exact asset/network, entry amount, pot/refund rules, and fee policy; require an explicit entry confirmation and keep the same terms in activity history.
- Replace the Intertrain ID purchase card with “Coming soon”; remove fake username/payment actions and routes.
- Use the dark/mint design system; motion should explain round transitions and elimination, not generic glow/pulse.

**Acceptance:** A first-time user understands the loop and stake terms before joining; accessible controls; no misleading username purchase CTA.

### Phase 2 — Wallet identity and Intertrain account migration

- Keep existing EVM/Solana/etc. keys and encrypted backup bytes unchanged.
- Add deterministic Intertrain Ed25519 derivation from the wallet’s recoverable root using a versioned path and domain separation. Do not derive a private key from the public EVM address.
- For an already provisioned random Intertrain key, preserve it. Add the derived account as a second explicitly reviewed account; never replace a funded address automatically.
- Show EVM and Intertrain `mna1…` addresses as related accounts under one wallet identity, with separate labels, copy actions, signing network, and recovery explanation.
- Explain that one recovery root yields different cryptographic keys/address strings; do not promise identical address formats.

**Acceptance:** Existing backups still recover old accounts; new wallets derive Intertrain deterministically; old funded Intertrain addresses remain accessible.

### Phase 3 — Arbitrum USDC → native Intertrain WSK settlement

- Keep source chain explicitly Arbitrum One and token explicitly native USDC. Do not silently switch to Ethereum USDC or USDC.e.
- Implement or integrate the verified `depositForWSK` observer/settlement path selected in Phase 0. Destination accounting is native WSK only.
- Preserve authenticated account ownership, local signing, strict transaction validation, exact amounts, safe allowance, fresh nonce, idempotency, and explicit destination binding.
- Replace fixed sleeps and retry-created operation IDs with a persisted operation, receipt-driven progression, and reload/reconnect recovery.
- Track exact approval receipt → deposit receipt/ID → source confirmations → destination processing → verified WSK balance/operation evidence. Only then mark complete and refresh destination balances.
- Report contract pause/config, external settlement worker health/lag, and operation status together. Fail closed if any required component is unavailable.

**Acceptance**

- A controlled deposit credits exactly the requested native WSK amount/account under the verified contract rules; it never creates wUSDC.
- Reload, retry, duplicate scans, and relayer restart do not double-mint or lose the operation.
- Approval or source submission alone never appears as completed funds.
- Each operation has source hash, deposit ID, destination, destination evidence, and user-readable status.

### Phase 4 — Native WSK balance visibility and valuation

- Show native WSK as its own Intertrain balance. Keep Arbitrum USDC on Arbitrum and pending bridge funds separate.
- Display WSK at $1 only while live reserve/collateral state and product policy support that valuation. A valuation is not a redemption guarantee.

**Acceptance:** Native WSK remains visible at zero/nonzero; Arbitrum USDC and pending deposits remain separate; WSK valuation shows its source/time and can degrade without hiding the balance.

### Phase 5 — Portfolio and wallet balance integration

- Reuse the existing Crypto Backend Intertrain adapter for native WSK (`chain_info`, `account_get`, six decimals).
- Show Arbitrum USDC, native Intertrain WSK, and pending WSK deposits as separate rows, grouped by network/account. Do not add wUSDC crediting to this integration.
- Combine subtotals only with explicit valuation source/time; do not value pending deposits as spendable funds.
- Use partial-failure states: Intertrain RPC failure must not hide Arbitrum balances; stale rows retain last-known values with timestamps/warnings.
- Deduplicate by canonical network/account/asset identity; never count a pending Arbitrum deposit as a second spendable balance.
- Include Arbiscan and Intertrain explorer links when hashes are available.

**Acceptance:** Portfolio includes native WSK even when zero, counts eligible holdings once, and labels pending/unpriced/stale balances.

### Phase 6 — Chess rules and board

- Use a tested backend rules engine as authority; client sends a move intent, never an authoritative board/result.
- Support castling, en passant, promotion, check/checkmate, stalemate, resignation, timeouts, draw conditions, and replay-safe versioned moves.
- Persist canonical FEN and move history/PGN; reject illegal, stale, duplicated, or out-of-turn moves atomically.
- Use recognizable SVG chess pieces, clear board orientation, legal-move hints, last-move highlight, promotion picker, move list, captured pieces, clocks/status, and reconnect behavior.
- Support touch, mouse, keyboard, screen reader, and reduced motion.

### Phase 7 — Signed-in invites and match lifecycle

- Require authentication to create, accept, or play. A logged-out invitee signs in first; the server then revalidates invitation and stake terms.
- Use high-entropy one-time invite tokens; store only a hash; bind match, creator, asset/network, exact stake, expiry, and terms.
- Preview the invitation without leaking private data. Prevent self-join, double acceptance, expiry/reuse, mismatched stake, and hidden network changes.
- Start only after both participants and matching entries are verified. Support decline, cancellation before acceptance, expiry, and refund.

### Phase 8 — Chess stake ledger, settlement, and responsible play

- Review existing Arcade ledger/deposit behavior before reuse. An internal credited balance is not necessarily withdrawable on-chain funds.
- Select stake asset/network explicitly. Do not imply Intertrain WSK or bridge support in the existing Solana USDC Arcade deposit path.
- Reserve stakes atomically; enforce idempotency and unique match-entry/settlement IDs.
- Settle only from a server-verified terminal result. Show payout, refund/draw policy, and any fee before entry; no hidden fee.
- Define disconnect, timeout, draw, void, dispute, worker restart, and outage fund treatment.
- Apply daily limits, cooldowns, self-exclusion, audit logs, and abuse controls. Do not launch staked play until custody and withdrawal boundaries are approved.

### Phase 9 — Shared activity, supportability, and polish

- Align Wallet, Portfolio, Bridge, Last Man, and Chess to the black/mint design system with consistent network/asset labels and responsive layouts.
- Add activity stages for approval, deposit, relay/mint, conversion, withdrawal, invite, stake reserve, result, refund, and payout.
- Add safe-retry guidance and operator reconciliation for deposits without destination mint.
- Monitor Arbitrum confirmations/relayer lag, Intertrain lane availability, reserve state, stale balances, failed intents, stuck operations, and settlement/refund backlog. Never log keys or operator secrets.
- Put hashes/raw IDs in expandable technical details rather than making them the primary experience.

### Phase 10 — Verification and staged rollout

1. Unit tests: route identity, decimals, approval amount, invite tokens, chess rules, valuation.
2. Integration tests: Arbitrum approval/deposit decoding, confirmations, idempotent WSK credit reconciliation, balance refresh, pause/cap failures, retries, restart recovery.
3. Backend tests: authentication/ownership, destination binding, intent validation, cross-account rejection, operation lifecycle, atomic game ledger.
4. Frontend tests: rejected signatures, chain switching, approval delay, reload between steps, reconnect, stale/partial balances, mobile chess, accessibility.
5. Read-only mainnet gate: compare the Arbitrum USDC token and `depositForWSK` contract, `paused()`, source events, Intertrain WSK account state, reserve status, and verified destination-credit worker. Do not gate this route on the separate Ethereum wUSDC registry lane.
6. Controlled mainnet smoke test: only after the worker and contract semantics are verified, send an explicitly approved minimal amount and reconcile source event to native WSK credit before broader rollout.

**Release gates**

- A: UI and non-monetary chess.
- B: deterministic Intertrain account and read-only native WSK balance.
- C: bridge status/history without enabling deposits.
- D: Arbitrum USDC → native WSK only after contract semantics and destination-credit worker pass end-to-end checks.
- F: staked chess after custody, payout, refund, responsible-play, and legal/product review.

Rollback disables new operations without deleting wallets, submitted intents, bridge records, or ledger history. Pending transfers remain visible and reconcilable.

## Repository boundary and ownership

- **TsionMarket backend:** Intertrain network/ownership/balance/valuation APIs, fail-closed Arbitrum bridge status, Last Man and Chess services, and the authoritative game/stake ledger.
- **TsionMarket frontend:** local wallet derivation and migration, wallet/portfolio/balance surfaces, bridge readiness and operation presentation, Last Man and Chess UX.
- **Dashboard Revamp and WorldStreet Crypto Backend:** reference-only. They may be inspected to verify the existing Arbitrum USDC → `depositForWSK` contract path and request/transaction conventions, but must not be edited by this implementation.
- **WorldStreet Chain:** reference-only for native Intertrain address derivation, RPC response semantics, and reserve status. Do not modify it or its separate Ethereum → wUSDC lane.

The destination-credit worker is not present in the two implementation repositories. Therefore the TsionMarket bridge surface must remain read-only/unavailable until its source receipt and destination WSK credit can be independently tied together; source-chain success alone is never shown as completed funds.

## Explicitly out of scope

- Any Ethereum → wUSDC integration, wUSDC crediting, or wUSDC lane changes.
- Treating the selected Arbitrum → native WSK route as wUSDC.
- Redeploying an existing bridge solely because roadmap or legacy docs say “not deployed.”
- Enabling Arbitrum deposits before the `depositForWSK` destination-credit worker is verified.
- Exposing relayer credentials, changing key derivation, or moving funded accounts without a migration.
- Launching staked chess before settlement, withdrawal, and responsible-play guarantees are clear.

## Phase 6–10 implementation status (2026-09-24)

### Delivered in TsionMarket

- **Phase 6 — Chess:** the backend uses `chess.js` as the rules authority. Matches store a canonical FEN, replayable PGN, versioned move records, captures, and server-side clocks. Castling, en passant, promotions, checkmate, stalemate, repetition, insufficient material, fifty-move draws, resignation, draw agreement, and clock expiry are handled server-side. Move writes are row-locked and reject illegal, out-of-turn, or stale versions. The frontend renders SVG pieces, automatic player orientation, legal destinations, last-move/check highlights, promotion selection, clocks, captures, move sheet, PGN, and a reconnecting match URL.
- **Phase 7 — Invites:** creating, previewing, accepting, declining, cancelling, and playing require authentication. Invitation links use 256-bit random tokens; only SHA-256 hashes are stored, tokens are single-use, and links expire after 24 hours. Acceptance is transactional and rejects self-join/races. Invitee links survive the login redirect, after which the backend rechecks the invitation. The invite API carries tokens in the request body, not logged route paths.
- **Phase 8 — Safety boundary:** chess currently has **no stake, deposit, entry charge, prize, or payout path**. This is intentional: the existing Arcade balance is an internal credit and the withdrawal/custody/dispute guarantees are not approved. The invitation schema rejects stake/network fields and the UI states that paid matches are unavailable. Release gate F remains closed.
- **Phase 9 — Chess operations/polish:** moves and final PGN are persisted for support and replay; a worker expires invitations and settles clock deadlines; participant-only match reads avoid exposing account identifiers. No signing keys or relayer credentials are used. The cross-product shared activity feed and bridge-operator reconciliation/metrics remain separate follow-up work; the bridge remains fail-closed until a destination-credit verifier exists.
- **Phase 10 — verification:** backend rules/API tests cover legal variants, draws, flag fall, authentication, strict no-stake request shapes, and malformed move rejection. Frontend type checks, tests, and production build are run before this change is pushed. A real-MySQL lifecycle test and any mainnet bridge smoke test still require the deployment DB and independently verified bridge credit worker; no mainnet funds are sent by this change.

### Remaining release gates

1. Apply backend migration `0022_chess_matches.sql` in each deployed environment before using Chess.
2. Keep paid Chess disabled until custody and withdrawal, settlement/refund/dispute policy, responsible-play controls, and legal/product review are approved.
3. Keep Arbitrum USDC → native WSK deposits unavailable until the destination-credit worker and source-to-destination reconciliation pass the read-only and controlled-smoke gates above.
