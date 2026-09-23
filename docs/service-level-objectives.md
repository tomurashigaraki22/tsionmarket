# Service Targets

These are initial engineering targets, measured server-side and reviewed after staging load tests.

| Operation                  | Availability target |              p95 latency target | Failure behavior                                   |
| -------------------------- | ------------------: | ------------------------------: | -------------------------------------------------- |
| Liveness                   |              99.99% |                           50 ms | Process-only response                              |
| Readiness                  |               99.9% |                          250 ms | 503 on MySQL/schema failure                        |
| Authentication             |               99.9% | 500 ms excluding email delivery | Fail closed                                        |
| Balance snapshot           |               99.5% |                             5 s | Partial per-network errors; stale data identified  |
| Market listing             |               99.9% |                          300 ms | Last known valid registry snapshot                 |
| Executable quote           |               99.5% |                             3 s | No executable quote on provider/validation failure |
| Intent creation/simulation |               99.5% |                             5 s | No intent when validation/simulation fails         |
| Submission acceptance      |               99.5% |                             5 s | Idempotent retry and later reconciliation          |

Budgets are not promises until staging validates providers and deployment capacity. Alerts should consume the error budget rather than alert on isolated failures.
