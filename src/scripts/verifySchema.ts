import 'dotenv/config'
import { getEnvironment } from '../config/env.js'
import { assertMigrationsCurrent, discoverMigrations, ensureMigrationTable } from '../db/migrations.js'
import { createApplicationPool } from '../db/pool.js'

const environment = getEnvironment()
const pool = createApplicationPool(environment)

try {
  await ensureMigrationTable(pool)
  await assertMigrationsCurrent(pool, await discoverMigrations())
  process.stdout.write('Database schema matches local migrations.\n')
} finally {
  await pool.end()
}
