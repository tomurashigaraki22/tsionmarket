import { describe, expect, it } from 'vitest'
import { resolveTick } from '../src/arcade/lastMan.js'

const alive = ['a', 'b', 'c', 'd', 'e']

describe('Last Man tick resolution', () => {
  it('keeps the minority and eliminates the majority', () => {
    const outcome = resolveTick(alive, [
      { userId: 'a', choice: 0 },
      { userId: 'b', choice: 1 },
      { userId: 'c', choice: 1 },
      { userId: 'd', choice: 1 },
      { userId: 'e', choice: 1 },
    ])
    expect(outcome.survivors).toEqual(['a'])
    expect(outcome.eliminated.sort()).toEqual(['b', 'c', 'd', 'e'])
    expect(outcome.reason).toBe('minority')
  })

  it('eliminates anyone who did not commit', () => {
    // Silence has to cost the round, or waiting becomes the dominant strategy.
    const outcome = resolveTick(alive, [
      { userId: 'a', choice: 0 },
      { userId: 'b', choice: 1 },
      { userId: 'c', choice: 1 },
    ])
    expect(outcome.eliminated).toContain('d')
    expect(outcome.eliminated).toContain('e')
    expect(outcome.survivors).toEqual(['a'])
  })

  it('eliminates nobody on a tie, but the silent are still out', () => {
    const outcome = resolveTick(['a', 'b', 'c'], [
      { userId: 'a', choice: 0 },
      { userId: 'b', choice: 1 },
    ])
    expect(outcome.repeat).toBe(true)
    expect(outcome.reason).toBe('tie')
    expect(outcome.survivors.sort()).toEqual(['a', 'b'])
    expect(outcome.eliminated).toEqual(['c'])
  })

  it('treats a unanimous tick as no minority at all', () => {
    const outcome = resolveTick(['a', 'b', 'c'], [
      { userId: 'a', choice: 1 },
      { userId: 'b', choice: 1 },
      { userId: 'c', choice: 1 },
    ])
    expect(outcome.repeat).toBe(true)
    expect(outcome.reason).toBe('unanimous')
    expect(outcome.eliminated).toEqual([])
  })

  it('leaves nobody standing when the whole round goes silent', () => {
    const outcome = resolveTick(alive, [])
    expect(outcome.survivors).toEqual([])
    expect(outcome.eliminated.sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(outcome.reason).toBe('silence')
  })

  it('lets a lone committer survive', () => {
    const outcome = resolveTick(['a', 'b'], [{ userId: 'a', choice: 0 }])
    expect(outcome.survivors).toEqual(['a'])
    expect(outcome.eliminated).toEqual(['b'])
  })

  it('ignores a move from someone not alive in the round', () => {
    // A stale client can still hold a round it has been eliminated from.
    const outcome = resolveTick(['a', 'b', 'c'], [
      { userId: 'a', choice: 0 },
      { userId: 'b', choice: 1 },
      { userId: 'c', choice: 1 },
      { userId: 'ghost', choice: 0 },
    ])
    expect(outcome.survivors).toEqual(['a'])
    expect(outcome.eliminated.sort()).toEqual(['b', 'c'])
  })

  it('resolves identically when the same tick is replayed', () => {
    // The round must be reconstructible from its moves, or a dispute cannot
    // be settled after the fact.
    const moves = [
      { userId: 'a', choice: 0 as const },
      { userId: 'b', choice: 0 as const },
      { userId: 'c', choice: 1 as const },
    ]
    expect(resolveTick(alive, moves)).toEqual(resolveTick(alive, moves))
  })
})
