import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { defaultMigrationsDirectory, discoverMigrations } from '../src/db/migrations.js'
import { allowlistedSqlValue } from '../src/db/safeSql.js'

describe('direct SQL safety and migrations', () => {
  it('discovers migrations in deterministic order with checksums', async () => {
    const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/migrations')
    const migrations = await discoverMigrations(directory)
    expect(migrations.map((migration) => migration.version)).toEqual(['0001', '0002'])
    expect(migrations.every((migration) => /^[a-f0-9]{64}$/.test(migration.checksum))).toBe(true)
  })

  it('includes the durable OnSwitch lifecycle and catalogue migrations in order', async () => {
    const migrations = await discoverMigrations(defaultMigrationsDirectory)
    const payment = migrations.find((migration) => migration.version === '0024')
    const catalogue = migrations.find((migration) => migration.version === '0025')
    const transfer = migrations.find((migration) => migration.version === '0026')

    expect(payment?.filename).toBe('0024_onswitch_payment_foundation.sql')
    expect(payment?.sql).toContain('CREATE TABLE payment_operations')
    expect(payment?.sql).toContain('CREATE TABLE onswitch_webhook_inbox')
    expect(catalogue?.filename).toBe('0025_onswitch_catalogue_cache.sql')
    expect(transfer?.filename).toBe('0026_onswitch_payment_transfer_intents.sql')
    expect(transfer?.sql).toContain("'payment_transfer'")
    expect(migrations.at(-1)?.version).toBe('0026')
  })

  it('rejects values that could become unsafe dynamic SQL', () => {
    expect(allowlistedSqlValue('created_at', ['created_at', 'price'] as const, 'sort')).toBe('created_at')
    expect(() =>
      allowlistedSqlValue('created_at DESC; DROP TABLE users', ['created_at'] as const, 'sort'),
    ).toThrow(/Invalid sort/)
  })
})
