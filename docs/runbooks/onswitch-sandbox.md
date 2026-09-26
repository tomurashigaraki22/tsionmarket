# OnSwitch sandbox rollout and operator runbook

This runbook covers a separate staging deployment and controlled pre-release
sandbox testing on the production host. The production Compose stack sets
`NODE_ENV=production` and keeps payments disabled by default; explicitly
selecting sandbox mode is supported when OnSwitch is enabled. Sandbox activity
is simulated provider activity, not proof of a real-money settlement.

## Preconditions

Before exposing the Switch sandbox to users, provision and record:

- A separate staging host/app origin and Compose project, with an isolated
  database and backups, is preferred for broader sandbox testing. It runs with
  `NODE_ENV=staging`. For a private pre-release production-host test, use only
  trusted test accounts and a dedicated test wallet; payment starts are
  otherwise available to signed-in users while enabled.
- The sandbox service key from Switch, injected through the deployment
  environment/secret store. It must never be committed or placed in a frontend
  variable.
- A dedicated `ONSWITCH_IDEMPOTENCY_SECRET` (at least 32 printable characters)
  and `ONSWITCH_DATA_ENCRYPTION_KEY` (32 random bytes represented by 64 hex
  characters). Keep the encryption key backed up with restricted access; losing
  or rotating it without re-encrypting pending instructions makes those
  instructions unreadable.
- A callback URL configured at Switch for the selected host, plus confirmation
  of sandbox corridor, asset/network, simulated settlement, and webhook
  behavior. Never use a live callback URL for sandbox events.
- A clearly visible “sandbox / simulated payments” disclosure in the staging
  app. Sandbox completion must not be presented as real money or an on-chain
  credit. The application does not credit wallet balances from provider status.

The repo currently contains only the development Compose stack and the live
production stack; it does **not** contain a named staging host or isolated
sandbox Compose project. Do not use `deploy/docker-compose.prod.yml` for this
runbook. The operator must provide/configure the isolated staging deployment
before rollout can be marked complete.

## Environment configuration

Set the following values in the selected API deployment's secret store. Keep
all new payment starts paused for the first deployment:

```ini
ONSWITCH_ENABLED=true
ONSWITCH_ENVIRONMENT=sandbox
ONSWITCH_ONRAMP_STARTS_ENABLED=false
ONSWITCH_OFFRAMP_STARTS_ENABLED=false
ONSWITCH_SANDBOX_SERVICE_KEY=<inject from secret store>
ONSWITCH_IDEMPOTENCY_SECRET=<dedicated random secret, 32+ characters>
ONSWITCH_DATA_ENCRYPTION_KEY=<dedicated 32-byte key encoded as 64 hex characters>
ONSWITCH_MAX_ACTIVE_OPERATIONS_PER_USER=5
```

For staging, set `NODE_ENV=staging`; the production Compose stack already sets
`NODE_ENV=production`, so do not override it in its env file. Do not set
`ONSWITCH_LIVE_SERVICE_KEY` in a sandbox deployment. Select a `NETWORK_MODE`
and verified test wallet/network combination supported by the provider's
sandbox account. Sandbox off-ramp flows must never request or sign a real
mainnet wallet transfer; that transfer-intent path remains blocked.

Deploy the application and apply migrations using the staging deployment's
normal process. Confirm migration `0028_onswitch_user_active_index.sql` is
applied before starting payment tests.

## Smoke test before opening starts

1. Confirm the staging API reports healthy and that the Switch capability
   endpoint is reachable by an authenticated staging user.
2. With both start flags still false, verify capability/history/status reads
   respond as expected. The capabilities response can have no available assets
   while both directions are paused.
3. Confirm a quote/new start is rejected as paused before any provider
   initiation call is made.
4. Enable one direction only; use a dedicated test account and one documented
   corridor returned by the provider for the test wallet. Do not invent or
   manually seed a corridor. Check quote amount/limits, idempotent retry, pending operation
   cap, reload/resume, webhook signature/replay behavior, reconciliation, and
   terminal instruction clearing. Verify sandbox payout cannot request a real
   mainnet transfer.
5. Check the staging audit events and metrics for rate-limit denials, pending
   operations, manual review, webhook backlog, oldest pending age, and worker
   errors. Confirm no key, bank details, request body, or provider response is
   logged.
6. Exercise the operator pause and verify pausing new starts does not stop
   status reads or reconciliation for existing operations.
7. Repeat the smoke test for the second direction, then obtain explicit
   product/provider approval before enabling both directions for all sandbox
   users. Keep the staging UI clearly marked as simulated.

The metrics are exposed by the existing protected `/metrics` endpoint. Alerting
and notification delivery still need an assigned receiver; gauges alone are not
an alert channel.

## Pause and rollback

- To pause new on-ramps or off-ramps independently, set the corresponding
  `ONSWITCH_*_STARTS_ENABLED=false` and restart/redeploy the staging API.
- To stop all provider API activity, set `ONSWITCH_ENABLED=false`. Existing
  history remains in the database, but the disabled integration cannot refresh
  provider state until re-enabled.
- Do not delete pending rows to clear an incident. Use status/reconciliation,
  investigate provider state, and route ambiguous cases to manual review.
- Preserve the isolated DB backup and restricted audit trail for investigation.

## Key rotation and retention

- Rotate the provider sandbox key in coordination with Switch. Update only the
  staging secret store, restart, then verify a harmless capability read. Never
  paste the key into logs, chat, or issue trackers.
- Rotate the idempotency secret only with an explicit plan for idempotency
  fingerprints already stored in the database; changing it can alter replay
  matching for existing requests.
- Before rotating the data encryption key, re-encrypt every still-pending
  instruction with a versioned key migration. The current envelope is
  authenticated AES-256-GCM; a wrong/missing key fails closed. Keep the old key
  until migration and backup-retention windows are complete.
- Pending legacy plaintext `safe_instructions` rows are encrypted on first read
  when the encryption key is configured; terminal legacy instructions are
  cleared. Review for unread legacy rows and remove the compatibility path only
  after they are migrated or deleted.
  Agree a retention/deletion policy for payment and security audit records with
  the privacy/compliance owner.

## Rollout status

Code and local CI safeguards are prepared, but this repository has no configured
staging target and no Switch sandbox key is present here. Until the above
deployment exists and its smoke tests pass, this is **not a completed sandbox
rollout**. Production remains disabled by default; enabling sandbox is an
explicit operator action.
