/**
 * The Last Man rules, as a pure function.
 *
 * Kept out of the repository so a tick can be resolved and replayed in a test
 * without standing up a round. This is the part where a wrong answer is
 * invisible rather than loud: an off-by-one in who survives looks like a
 * normal round to everyone watching.
 */

export type Move = { userId: string; choice: 0 | 1 }

export type TickOutcome = {
  /** Still in after this tick. */
  survivors: Array<string>
  /** Out at this tick, whether by silence or by being in the majority. */
  eliminated: Array<string>
  /**
   * Nobody was eliminated and the tick should be replayed — a tie, or a
   * unanimous choice, neither of which produces a minority.
   */
  repeat: boolean
  reason: 'minority' | 'tie' | 'unanimous' | 'silence' | 'empty'
}

/**
 * Resolves one tick.
 *
 * Two independent eliminations happen here, in order:
 *
 *  1. Anyone alive who did not commit is out. Silence is a choice, and
 *     allowing it to be safe would make waiting the dominant strategy.
 *  2. Among those who did commit, the MINORITY choice survives.
 *
 * A tie or a unanimous tick cannot produce a minority, so nobody in step 2 is
 * eliminated and the tick repeats — but the step-1 eliminations still stand,
 * because failing to commit is not excused by what everyone else picked.
 */
export function resolveTick(alive: ReadonlyArray<string>, moves: ReadonlyArray<Move>): TickOutcome {
  if (alive.length === 0)
    return { survivors: [], eliminated: [], repeat: false, reason: 'empty' }

  const committed = new Map<string, 0 | 1>()
  for (const move of moves) {
    // Ignore anything from a player who is not alive in this round: a stale
    // client can still hold a round it has been eliminated from.
    if (alive.includes(move.userId)) committed.set(move.userId, move.choice)
  }

  const silent = alive.filter((userId) => !committed.has(userId))
  const zero = [...committed].filter(([, choice]) => choice === 0).map(([userId]) => userId)
  const one = [...committed].filter(([, choice]) => choice === 1).map(([userId]) => userId)

  // Nobody moved at all. Everyone is out on silence; the caller decides what
  // that means for the round.
  if (committed.size === 0)
    return { survivors: [], eliminated: silent, repeat: false, reason: 'silence' }

  // No division, so no minority: the committers all continue and the tick is
  // replayed. The silent are still out.
  if (zero.length === one.length || zero.length === 0 || one.length === 0) {
    return {
      survivors: [...committed.keys()],
      eliminated: silent,
      repeat: true,
      reason: zero.length === one.length ? 'tie' : 'unanimous',
    }
  }

  const minority = zero.length < one.length ? zero : one
  const majority = zero.length < one.length ? one : zero
  return {
    survivors: minority,
    eliminated: [...silent, ...majority],
    repeat: false,
    reason: 'minority',
  }
}
