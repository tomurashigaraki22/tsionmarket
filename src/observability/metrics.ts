import type { RequestHandler } from 'express'
import type { Environment } from '../config/env.js'

const counters = new Map<string, number>(),
  durations = new Map<string, { count: number; sum: number }>()
const safe = (value: string) => value.replace(/[^a-zA-Z0-9_]/g, '_')
export const increment = (name: string, amount = 1) =>
  counters.set(safe(name), (counters.get(safe(name)) ?? 0) + amount)

/**
 * Records a server-to-server provider call using only a bounded provider name,
 * method, fixed endpoint path, status, and duration. Callers must never pass
 * request URLs, query values, user IDs, or response text as metric labels.
 */
export function recordOutboundRequest(
  provider: string,
  method: string,
  path: string,
  status: number | string,
  durationMs: number,
): void {
  const endpoint = safe(path.replace(/^\/+/, '')).slice(0, 80) || 'unknown'
  const outcome = safe(String(status)).slice(0, 32) || 'unknown'
  const providerName = safe(provider).slice(0, 32) || 'unknown'
  const verb = safe(method).slice(0, 16) || 'unknown'
  const requestKey = `provider_requests_total_${providerName}_${verb}_${endpoint}_${outcome}`
  increment(requestKey)

  const durationKey = `provider_request_duration_ms_${providerName}_${verb}_${endpoint}`
  const entry = durations.get(durationKey) ?? { count: 0, sum: 0 }
  entry.count++
  entry.sum += Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0
  durations.set(durationKey, entry)
}

/**
 * The normalized route pattern (e.g. `/v1/transactions/:transactionId`), not
 * the literal request path. `req.path` for that same request would contain
 * the actual transaction UUID — a distinct string per transaction ever
 * requested — which would give this in-memory, never-evicted Map one entry
 * per UUID/address/cursor ever seen rather than one per route. That is an
 * unbounded memory leak and it defeats the point of the metric, which is
 * "latency and error rate by route" per Phase 13, not by individual resource.
 *
 * Express only populates `req.route` once a route has matched, which happens
 * before `res.on('finish')` fires below, so it's available by read time. A
 * request that never matched a route (a 404, or one rejected in earlier
 * middleware) falls back to a fixed label instead of the raw path.
 */
function normalizedRoute(req: Parameters<RequestHandler>[0]): string {
  const pattern = (req as { route?: { path?: string } }).route?.path
  if (typeof pattern === 'string') return safe(`${req.baseUrl}${pattern}`)
  return 'unmatched'
}

export function metricsMiddleware(): RequestHandler {
  return (req, res, next) => {
    const started = performance.now()
    res.on('finish', () => {
      const route = normalizedRoute(req),
        key = `http_requests_total_${req.method}_${route}_${res.statusCode}`
      increment(key)
      const durationKey = `http_request_duration_ms_${req.method}_${route}`,
        entry = durations.get(durationKey) ?? { count: 0, sum: 0 }
      entry.count++
      entry.sum += performance.now() - started
      durations.set(durationKey, entry)
    })
    next()
  }
}
export function metricsHandler(env: Environment): RequestHandler {
  return (req, res) => {
    if (!env.METRICS_ENABLED) {
      res.status(404).end()
      return
    }
    if (env.METRICS_BEARER_TOKEN && req.header('authorization') !== `Bearer ${env.METRICS_BEARER_TOKEN}`) {
      res.status(401).end()
      return
    }
    const lines: string[] = []
    for (const [name, value] of counters) lines.push(`# TYPE ${name} counter`, `${name} ${value}`)
    for (const [name, value] of durations)
      lines.push(
        `# TYPE ${name} summary`,
        `${name}_count ${value.count}`,
        `${name}_sum ${value.sum.toFixed(3)}`,
      )
    res.type('text/plain; version=0.0.4').send(`${lines.join('\n')}\n`)
  }
}
