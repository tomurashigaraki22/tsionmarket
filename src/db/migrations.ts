import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Pool, RowDataPacket } from 'mysql2/promise'

export type Migration = {
  version: string
  name: string
  filename: string
  checksum: string
  sql: string
}

type AppliedMigration = RowDataPacket & { version: string; checksum: string }

export const defaultMigrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
)

export async function discoverMigrations(directory = defaultMigrationsDirectory): Promise<Migration[]> {
  const filenames = (await readdir(directory)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort()
  const migrations = await Promise.all(
    filenames.map(async (filename) => {
      const sql = await readFile(path.join(directory, filename), 'utf8')
      const separator = filename.indexOf('_')
      return {
        version: filename.slice(0, separator),
        name: filename.slice(separator + 1, -4),
        filename,
        checksum: createHash('sha256').update(sql).digest('hex'),
        sql,
      }
    }),
  )
  const versions = new Set<string>()
  for (const migration of migrations) {
    if (versions.has(migration.version)) throw new Error(`Duplicate migration version: ${migration.version}`)
    versions.add(migration.version)
  }
  return migrations
}

export async function ensureMigrationTable(pool: Pool): Promise<void> {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(32) NOT NULL PRIMARY KEY,
      name VARCHAR(191) NOT NULL,
      checksum CHAR(64) NOT NULL,
      applied_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `)
}

export async function getAppliedMigrations(pool: Pool): Promise<Map<string, string>> {
  const [rows] = await pool.query<AppliedMigration[]>(
    'SELECT version, checksum FROM schema_migrations ORDER BY version',
  )
  return new Map(rows.map((row) => [row.version, row.checksum]))
}

export async function assertMigrationsCurrent(pool: Pool, migrations: Migration[]): Promise<void> {
  const applied = await getAppliedMigrations(pool)
  for (const migration of migrations) {
    const checksum = applied.get(migration.version)
    if (!checksum) throw new Error(`Pending migration: ${migration.filename}`)
    if (checksum !== migration.checksum) throw new Error(`Migration checksum mismatch: ${migration.filename}`)
  }
  for (const version of applied.keys()) {
    if (!migrations.some((migration) => migration.version === version)) {
      throw new Error(`Database contains unknown migration version: ${version}`)
    }
  }
}

export async function runMigrations(
  pool: Pool,
  lockTimeoutSeconds: number,
  directory?: string,
): Promise<void> {
  const migrations = await discoverMigrations(directory)
  const connection = await pool.getConnection()
  let locked = false
  try {
    const [lockRows] = await connection.query<RowDataPacket[]>('SELECT GET_LOCK(?, ?) AS acquired', [
      'tsionmarket_schema_migrations',
      lockTimeoutSeconds,
    ])
    locked = Number(lockRows[0]?.acquired) === 1
    if (!locked) throw new Error('Could not acquire the migration lock')

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(32) NOT NULL PRIMARY KEY,
        name VARCHAR(191) NOT NULL,
        checksum CHAR(64) NOT NULL,
        applied_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `)
    const [rows] = await connection.query<AppliedMigration[]>(
      'SELECT version, checksum FROM schema_migrations ORDER BY version',
    )
    const applied = new Map(rows.map((row) => [row.version, row.checksum]))

    for (const migration of migrations) {
      const checksum = applied.get(migration.version)
      if (checksum && checksum !== migration.checksum) {
        throw new Error(`Migration checksum mismatch: ${migration.filename}`)
      }
      if (checksum) continue

      // MySQL DDL may auto-commit. A failure is deliberately not described as
      // rolled back; the runbook requires inspection and forward repair/restore.
      await connection.query(migration.sql)
      await connection.execute('INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)', [
        migration.version,
        migration.name,
        migration.checksum,
      ])
    }
  } finally {
    if (locked) await connection.query('SELECT RELEASE_LOCK(?)', ['tsionmarket_schema_migrations'])
    connection.release()
  }
}
