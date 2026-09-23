import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { parseEnvironment } from '../src/config/env.js'
import { increment, metricsHandler, metricsMiddleware } from '../src/observability/metrics.js'

const base = {
  MYSQL_HOST: 'localhost',
  MYSQL_DATABASE: 'test',
  MYSQL_USER: 'test',
  MYSQL_PASSWORD: 'test',
  MYSQL_MIGRATION_USER: 'migrator',
  MYSQL_MIGRATION_PASSWORD: 'test',
}
describe('metrics protection', () => {
  it('requires the configured bearer token and emits Prometheus counters', async () => {
    const env = parseEnvironment({ ...base, METRICS_BEARER_TOKEN: 'a'.repeat(32) }),
      app = express()
    app.get('/metrics', metricsHandler(env))
    increment('submission_outcomes_total')
    await request(app).get('/metrics').expect(401)
    const response = await request(app)
      .get('/metrics')
      .set('authorization', `Bearer ${'a'.repeat(32)}`)
      .expect(200)
    expect(response.text).toContain('submission_outcomes_total 1')
  })
})

describe('metrics route normalization', () => {
  it('groups requests by route pattern, not by the literal resource id', async () => {
    const env = parseEnvironment({ ...base, METRICS_BEARER_TOKEN: 'b'.repeat(32) }),
      app = express()
    app.use(metricsMiddleware())
    app.get('/v1/transactions/:transactionId', (_req, res) => res.status(200).end())
    app.get('/metrics', metricsHandler(env))

    // Two distinct UUIDs hitting the same route pattern.
    await request(app)
      .get('/v1/transactions/11111111-1111-1111-1111-111111111111')
      .expect(200)
    await request(app)
      .get('/v1/transactions/22222222-2222-2222-2222-222222222222')
      .expect(200)

    const response = await request(app)
      .get('/metrics')
      .set('authorization', `Bearer ${'b'.repeat(32)}`)
      .expect(200)

    // One counter for the route, incremented twice — not one counter per UUID.
    expect(response.text).toContain(
      'http_requests_total_GET__v1_transactions__transactionId_200 2',
    )
    expect(response.text).not.toContain('11111111')
    expect(response.text).not.toContain('22222222')
  })

  it('falls back to a fixed label for requests that matched no route', async () => {
    const env = parseEnvironment({ ...base, METRICS_BEARER_TOKEN: 'c'.repeat(32) }),
      app = express()
    app.use(metricsMiddleware())
    app.get('/metrics', metricsHandler(env))

    await request(app).get('/definitely/not/a/real/route').expect(404)

    const response = await request(app)
      .get('/metrics')
      .set('authorization', `Bearer ${'c'.repeat(32)}`)
      .expect(200)

    expect(response.text).toContain('http_requests_total_GET_unmatched_404 1')
    expect(response.text).not.toContain('definitely_not_a_real_route')
  })
})
