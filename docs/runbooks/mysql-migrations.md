# MySQL Migration and Recovery Runbook

## Normal rollout

1. Back up the production database and verify recent point-in-time recovery coverage.
2. Run `npm run db:verify` against the current release.
3. Review new immutable SQL files and their online-DDL/locking impact.
4. Run `npm run db:migrate` once using migration credentials. The command obtains a MySQL advisory lock.
5. Run `npm run db:verify` using application credentials.
6. Deploy API replicas only after migration success.

Application replicas never apply migrations during startup.

## Failure

MySQL DDL may auto-commit, so a failed migration is not assumed to roll back. Stop rollout, keep the API on the compatible prior release where safe, inspect the exact applied DDL, restore from backup or write a reviewed forward repair migration, and do not edit an already-recorded migration file.

## Local reset

Local database state is stored in the `tsionmarket_mysql_data` Docker volume. Removing it destroys local data and is never a production recovery procedure.
