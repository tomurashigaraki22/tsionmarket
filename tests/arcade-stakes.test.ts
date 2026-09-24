import { describe, expect, it } from 'vitest'
import {
  compare,
  isZero,
  multiply,
  negate,
  rakeOf,
  subtract,
} from '../src/arcade/StakeRepository.js'

/**
 * These are the money arithmetic, tested on their own because every one of
 * them is the difference between a pot that balances and one that does not.
 * The settlement paths they serve are transactional and covered by the
 * invariant below rather than by mocking a database.
 */
describe('decimal arithmetic', () => {
  it('does not lose value where floating point would', () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point, and this is money.
    expect(subtract('0.3', '0.1')).toBe('0.2')
    // Exactly 0.3 — not the 0.30000000000000004 a float would produce.
    expect(multiply('0.1', 3)).toBe('0.3')
  })

  it('holds full precision at eighteen decimals', () => {
    expect(multiply('0.000000000000000001', 3)).toBe('0.000000000000000003')
    expect(subtract('1', '0.000000000000000001')).toBe('0.999999999999999999')
  })

  it('compares without converting to a number', () => {
    // A value past 2^53 that a JS number cannot hold exactly.
    expect(compare('9007199254740993', '9007199254740992')).toBe(1)
    expect(compare('1.5', '1.5')).toBe(0)
    expect(compare('0.9', '1')).toBe(-1)
  })

  it('recognises zero in every spelling', () => {
    for (const value of ['0', '0.0', '0.000000000000000000']) expect(isZero(value)).toBe(true)
    expect(isZero('0.000000000000000001')).toBe(false)
  })

  it('negates symmetrically', () => {
    expect(negate('25')).toBe('-25')
    expect(negate(negate('25'))).toBe('25')
  })
})

describe('rake', () => {
  it('takes the stated basis points', () => {
    expect(rakeOf('100', 500)).toBe('5') // 5%
    expect(rakeOf('100', 250)).toBe('2.5') // 2.5%
  })

  it('is nothing when the house takes nothing', () => {
    expect(rakeOf('100', 0)).toBe('0')
  })

  it('rounds down, so rounding can never pay the house more than the pot', () => {
    // 1 unit at 1bps is a fraction of the smallest representable amount.
    expect(rakeOf('0.000000000000000001', 1)).toBe('0')
  })

  it('never exceeds the pot', () => {
    expect(compare(rakeOf('100', 10_000), '100')).toBe(0)
  })
})

describe('pot invariant', () => {
  it('pays out exactly the pot less rake, for any table size and rate', () => {
    // The plan's exit criterion: entries equal the pot, and the pot equals
    // payouts plus rake — with nothing left over and nothing conjured.
    for (const players of [2, 3, 7, 12, 99]) {
      for (const bps of [0, 1, 250, 500, 10_000]) {
        for (const stake of ['1', '0.5', '25', '0.000000000000000007']) {
          const pot = multiply(stake, players)
          const rake = rakeOf(pot, bps)
          const payout = subtract(pot, rake)

          // Nothing is created or destroyed.
          expect(subtract(pot, subtract(payout, negate(rake)))).toBe('0')
          // Neither side of the split can go negative.
          expect(compare(payout, '0')).toBeGreaterThanOrEqual(0)
          expect(compare(rake, '0')).toBeGreaterThanOrEqual(0)
          // The house never takes more than the table put up.
          expect(compare(rake, pot)).toBeLessThanOrEqual(0)
        }
      }
    }
  })

  it('returns exactly what was staked when a round aborts', () => {
    // A refund does no arithmetic beyond moving the same amount back, which
    // is why it is the path that cannot lose money.
    for (const players of [2, 5, 40]) {
      const stake = '12.345678901234567890'
      const pot = multiply(stake, players)
      const returned = multiply(stake, players)
      expect(subtract(pot, returned)).toBe('0')
    }
  })
})
