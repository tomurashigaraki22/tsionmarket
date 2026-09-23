/** Matches a trailing zone designator: 'Z', '+00:00', '-0500'. */
const ZONED = /(?:Z|[+-]\d{2}:?\d{2})$/

/**
 * The pool runs with `dateStrings: true` (see pool.ts), so DATETIME and
 * TIMESTAMP columns arrive as 'YYYY-MM-DD HH:MM:SS[.ffffff]' rather than as
 * Date objects. That form is not ISO 8601, so `new Date(value)` interprets it
 * in the process's local zone — correct only by accident when TZ happens to be
 * UTC. The server stores UTC (--default-time-zone=+00:00), so pin the zone
 * explicitly instead of relying on the container's TZ.
 *
 * Values that already carry a zone are passed through untouched: these
 * timestamps gate challenge expiry, and appending a second 'Z' would yield an
 * Invalid Date, whose comparisons are all false — an expired challenge would
 * read as still valid.
 */
export function fromMysqlDateTime(value: string | Date): Date {
  if (value instanceof Date) return value
  if (ZONED.test(value)) return new Date(value)
  return new Date(`${value.replace(' ', 'T')}Z`)
}
