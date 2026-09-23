import 'dotenv/config'
import { getEnvironment } from '../config/env.js'
import { createMigrationPool } from './pool.js'
import { runMigrations } from './migrations.js'

const environment = getEnvironment()
const pool = createMigrationPool(environment)

try {
  await runMigrations(pool, environment.MYSQL_MIGRATION_LOCK_TIMEOUT_SECONDS)
  process.stdout.write('Database migrations are current.\n')
} finally {
  await pool.end()
}
