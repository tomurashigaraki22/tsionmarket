# Phase 4 and Phase 5 implementation status

## Delivered

- Direct-SQL MySQL schema for network catalogue, frontend-provisioned public accounts, spot markets, and registry health.
- Runtime network-mode gate preventing development/testnet and mainnet mixing.
- The same RPC environment-key contract as `dashboard-revamp` and `worldstreet-crypto-backend`, including ordered comma-separated pools, fallbacks, provider cooldown, bounded retries, and a pinned Solana devnet endpoint.
- Authenticated public-account registration/listing. The backend stores addresses only; it does not provision wallets or receive private keys, PINs, passphrases, or encrypted key packages.
- EVM and Solana balance adapters for native assets and an explicit token allowlist, returning raw base units, decimals, and formatted values.
- Portfolio aggregation with bounded concurrency, in-flight request coalescing, short TTL caching, per-account partial errors, and stale-cache fallback.
- LI.FI-based Ethereum/Arbitrum and Jupiter-based Solana market registry, using 0x and Jupiter as venue identifiers and USDC as quote asset.
- Transactional route replacement: a failed upstream fetch preserves the last successful catalogue; missing markets are deactivated rather than deleted.
- Stable, cursor-paginated market API with network, venue, and search filters plus registry staleness metadata.

## API surface

- `GET /v1/networks`
- `POST /v1/wallets/me/accounts`
- `GET /v1/wallets/me/accounts`
- `GET /v1/wallets/me/balances?refresh=true`
- `GET /v1/markets?networkId=&venue=&search=&limit=&cursor=`

All routes are behind the existing handmade bearer-token authentication boundary.

## Operational notes

- Mainnet networks are enabled only with `NETWORK_MODE=mainnet`.
- Market synchronization is off by default and requires `SPOT_MARKET_REGISTRY_ENABLED=true`.
- RPC credentials remain environment-only and are never persisted or returned by APIs.
- Docker/MySQL migrations and live RPC/provider checks must be run in an environment with Docker and configured provider credentials before release.
