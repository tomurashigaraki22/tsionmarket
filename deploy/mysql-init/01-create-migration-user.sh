#!/bin/bash
# Runs once, on first database initialisation only.
#
# Production config requires the application user and the migration user to be
# different, so the app connection cannot run DDL. The app user is created by
# the MySQL image from MYSQL_USER/MYSQL_PASSWORD; this adds the migrator.
set -euo pipefail

: "${MYSQL_DATABASE:?}"
: "${MYSQL_MIGRATION_USER:?}"
: "${MYSQL_MIGRATION_PASSWORD:?}"

mysql --protocol=socket -uroot -p"${MYSQL_ROOT_PASSWORD}" <<SQL
CREATE USER IF NOT EXISTS '${MYSQL_MIGRATION_USER}'@'%'
  IDENTIFIED BY '${MYSQL_MIGRATION_PASSWORD}';

-- Schema changes plus the row access migrations need to backfill data.
GRANT SELECT, INSERT, UPDATE, DELETE,
      CREATE, ALTER, DROP, INDEX, REFERENCES,
      CREATE TEMPORARY TABLES, LOCK TABLES
  ON \`${MYSQL_DATABASE}\`.* TO '${MYSQL_MIGRATION_USER}'@'%';

FLUSH PRIVILEGES;
SQL

echo "Created migration user '${MYSQL_MIGRATION_USER}' on '${MYSQL_DATABASE}'."
