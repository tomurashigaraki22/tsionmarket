# Phase 0–1 Delivery Status

## Complete

- Spot-market product/custody/authentication baseline documented.
- API conventions, endpoint ownership, errors, and initial sequences documented.
- Threat model and reference port/adapt/exclude inventory documented.
- Service targets and MySQL migration/recovery runbook documented.
- TypeScript/Express application scaffolded without an ORM.
- Direct `mysql2/promise` pool, bounded queue/acquisition, transactions, SQL migrations, checksums, and advisory lock implemented.
- Environment safety validation, request IDs, structured errors, Helmet, CORS, body limits, rate limiting, liveness, readiness, and graceful shutdown implemented.
- Dockerfile, containerized MySQL Compose service, migration job, persistent volume, and API service defined.
- Formatting, lint, strict typecheck, unit tests, build, production dependency audit, and CI workflow implemented.

## Environment-dependent verification pending

- Docker image build and live Compose/MySQL migration/readiness smoke test. Docker is not installed on the implementation host. Run the commands in `README.md` on a Docker-enabled machine before merging or deploying.
