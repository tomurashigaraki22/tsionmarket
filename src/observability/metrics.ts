import type { RequestHandler } from 'express'
import type { Environment } from '../config/env.js'

const counters = new Map<string, number>(),
  durations = new Map<string, { count: number; sum: number }>()
const safe = (value: string) => value.replace(/[^a-zA-Z0-9_]/g, '_')
export const increment = (name: string, amount = 1) =>
  counters.set(safe(name), (counters.get(safe(name)) ?? 0) + amount)
export function metricsMiddleware(): RequestHandler {
  return (req, res, next) => {
    const started = performance.now()
    res.on('finish', () => {
      const route = safe(req.path),
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
