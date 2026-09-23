# Threat Model

## Assets

- User credentials, sessions, verification/recovery tokens, and personal data.
- Public wallet ownership mappings and transaction history.
- Quote and transaction-intent integrity.
- Provider/RPC/API credentials.
- MySQL availability, integrity, backups, and migration history.
- Operational controls and audit events.

Wallet private keys, seed phrases, recovery secrets, and wallet DEKs are deliberately not backend assets because they remain on the frontend.

## Trust boundaries

```text
Untrusted browser/mobile client
          |
          v
TLS / HTTP validation / auth / rate limits
          |
          v
TsionMarket API -----> MySQL
          |
          +----------> market/quote providers
          +----------> chain RPC providers
```

Provider responses are untrusted input. Internal routes are a separate boundary and never impersonate users.

## Threats and required controls

| Threat                               | Controls                                                                                                       | Validation                      |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Credential stuffing/account takeover | Argon2id, breached-password check, IP/account throttles, generic errors, session audit/revocation              | Phase 2 security tests          |
| Refresh-token theft/replay           | Opaque hashed tokens, rotate each use, family reuse detection, secure cookie, CSRF/Origin checks               | Concurrent/replay tests         |
| Cross-user object access             | Immutable user ID from access token; ownership enforced in the SQL query, not post-filtered                    | Negative integration tests      |
| SQL injection                        | Parameterized values; explicit columns; allowlisted dynamic identifiers; no ORM/raw client input interpolation | Unit/security tests and review  |
| Wallet impersonation                 | One-time expiring challenge; chain-native signature and address derivation verification                        | Phase 3 proof tests             |
| Backend wallet compromise            | Backend never receives wallet secrets and rejects secret-like input fields                                     | Schema/log scanning tests       |
| Quote tampering/stale quote          | Server derives metadata, hashes/persists route, enforces expiry/slippage and recipient                         | Phase 6 mutation tests          |
| Insufficient funds/gas               | Fresh source/native balance and allowance checks; repeat where practical                                       | Boundary/provider-failure tests |
| Signed-payload substitution          | Bind all security-sensitive signed fields to stored reviewed intent                                            | Phase 7–8 mutation tests        |
| Replay/double submission             | Unique idempotency constraints and guarded atomic state transition                                             | Concurrency tests               |
| Malicious/stale provider             | Validate response semantics, multiple configured RPCs, timestamp/freshness, fail closed                        | Contract/failover tests         |
| Secret leakage                       | Structured allowlist logging/redaction; no request bodies/tokens; secret scanning                              | Tests and CI                    |
| Migration tampering                  | Immutable files, SHA-256 checksums, migration table, advisory lock                                             | Phase 1 tests                   |
| Database loss/corruption             | Persistent volume locally; production backups, point-in-time recovery, restore drills                          | Phase 10 runbook/drill          |
| Denial of service                    | Body limits, bounded pool/concurrency, timeouts, rate limits, graceful shutdown                                | Load and failure tests          |

## Phase 1 residual risks

- Authentication and ownership enforcement are specified but not implemented until Phase 2/3.
- Docker development credentials are intentionally local defaults and must never be used in staging/production.
- Legal/compliance region approval remains a release gate.
- Independent security review remains required before mainnet funds.
