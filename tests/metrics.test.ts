import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { parseEnvironment } from '../src/config/env.js'
import { increment, metricsHandler } from '../src/observability/metrics.js'

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
