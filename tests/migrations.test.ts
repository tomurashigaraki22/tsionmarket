import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { discoverMigrations } from '../src/db/migrations.js'
import { allowlistedSqlValue } from '../src/db/safeSql.js'

describe('direct SQL safety and migrations', () => {
  it('discovers migrations in deterministic order with checksums', async () => {
    const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/migrations')
    const migrations = await discoverMigrations(directory)
    expect(migrations.map((migration) => migration.version)).toEqual(['0001', '0002'])
    expect(migrations.every((migration) => /^[a-f0-9]{64}$/.test(migration.checksum))).toBe(true)
  })

  it('rejects values that could become unsafe dynamic SQL', () => {
    expect(allowlistedSqlValue('created_at', ['created_at', 'price'] as const, 'sort')).toBe('created_at')
    expect(() =>
      allowlistedSqlValue('created_at DESC; DROP TABLE users', ['created_at'] as const, 'sort'),
    ).toThrow(/Invalid sort/)
  })
})
