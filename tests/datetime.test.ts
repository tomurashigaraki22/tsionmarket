import { describe, expect, it } from 'vitest'
import { fromMysqlDateTime } from '../src/db/datetime.js'

describe('fromMysqlDateTime', () => {
  it('reads a driver datestring as UTC, not local time', () => {
    // What mysql2 returns for TIMESTAMP(6) under dateStrings: true.
    expect(fromMysqlDateTime('2026-09-23 22:03:32.343000').toISOString()).toBe(
      '2026-09-23T22:03:32.343Z',
    )
  })

  it('passes through values that already carry a zone', () => {
    for (const value of ['2026-09-23T22:03:32.343Z', '2026-09-23T22:03:32+00:00']) {
      expect(Number.isNaN(fromMysqlDateTime(value).getTime())).toBe(false)
    }
    expect(fromMysqlDateTime('2026-09-23T22:03:32.343Z').toISOString()).toBe(
      '2026-09-23T22:03:32.343Z',
    )
  })

  it('never yields an Invalid Date for the formats expiry checks receive', () => {
    // An Invalid Date compares false against everything, so an expired
    // challenge would silently read as still valid.
    const expired = fromMysqlDateTime(new Date(Date.now() - 1000).toISOString())
    expect(expired.getTime()).toBeLessThan(Date.now())
  })

  it('returns Date instances unchanged', () => {
    const date = new Date('2026-09-23T22:03:32.343Z')
    expect(fromMysqlDateTime(date)).toBe(date)
  })
})
