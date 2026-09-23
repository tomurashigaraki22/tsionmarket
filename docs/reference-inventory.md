# Worldstreet Reference Inventory

This inventory classifies concepts from `worldstreet-crypto-backend`. Code is not copied wholesale because TsionMarket uses first-party auth, direct MySQL, and frontend-only wallet provisioning.

| Reference area                  | Decision          | TsionMarket treatment                                                           |
| ------------------------------- | ----------------- | ------------------------------------------------------------------------------- |
| Express app/security middleware | Adapt             | Preserve request IDs, Helmet, CORS, rate limits, errors; use TsionMarket config |
| Clerk authentication            | Exclude           | Replace with Phase 2 first-party authentication                                 |
| Mongoose/models/repositories    | Exclude           | Direct parameterized MySQL SQL only                                             |
| MongoDB operations              | Exclude           | Containerized MySQL, SQL migrations, backups/PITR                               |
| Backend wallet package storage  | Exclude           | Wallet provisioning/storage remains frontend-only                               |
| Wallet ownership invariants     | Port concept      | Enforce immutable user ownership in SQL joins                                   |
| Chain adapter interface         | Adapt later       | Include only configured EVM/Solana requirements                                 |
| Balance snapshot behavior       | Adapt later       | Preserve bounded concurrency, coalescing, timeouts, partial failure             |
| Spot market registry            | Adapt later       | Normalize into relational tables and direct SQL queries                         |
| Quote/approval flows            | Adapt later       | Preserve validation and local-signing boundary                                  |
| Transaction intents             | Port concept      | Store exact reviewed payload; direct SQL/idempotency constraints                |
| Reconciler                      | Adapt later       | Use MySQL guarded state transitions and bounded polling                         |
| Emergency pause/mainnet gates   | Port concept      | Durable MySQL operational controls and fail-closed configuration                |
| Session/delegated authority     | Exclude initially | No autonomous/backend signer                                                    |
| Launchpad/bridge/Hyperliquid    | Exclude initially | Separate future product decisions                                               |
