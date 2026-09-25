import express from 'express'
import request from 'supertest'
import type { Pool, PoolConnection } from 'mysql2/promise'
import { describe, expect, it, vi } from 'vitest'
import { userRateLimit } from '../src/api/middleware/userRateLimit.js'
import { OnSwitchPaymentRepository } from '../src/payments/onswitch/repository.js'

describe('OnSwitch abuse controls', () => {
  it('applies the user bucket across changing client IPs but isolates other users', async () => {
    const app = express()
    app.set('trust proxy', true)
    app.use((req, _res, next) => {
      req.identity = { userId: req.header('x-test-user') ?? 'unknown' } as never
      req.requestId = 'rate-limit-test'
      next()
    })
    app.get('/payments', userRateLimit({ windowMs: 60_000, limit: 1 }), (_req, res) => res.sendStatus(200))

    const first = await request(app).get('/payments').set('x-test-user', 'user-a')
    const blocked = await request(app)
      .get('/payments')
      .set('x-test-user', 'user-a')
      .set('x-forwarded-for', '203.0.113.8')
    const otherUser = await request(app).get('/payments').set('x-test-user', 'user-b')

    expect(first.status).toBe(200)
    expect(blocked.status).toBe(429)
    expect(blocked.body).toMatchObject({
      success: false,
      error: { code: 'RATE_LIMITED' },
      requestId: 'rate-limit-test',
    })
    expect(otherUser.status).toBe(200)
  })

  it('atomically denies a new operation at the per-user pending cap and records the denial', async () => {
    const queries: string[] = []
    const connection = {
      beginTransaction: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
      release: vi.fn(),
      execute: vi.fn(async (sql: string) => {
        queries.push(sql)
        if (sql.includes('request_fingerprint AS requestFingerprint')) return [[], []]
        if (sql.includes('SELECT id FROM users')) return [[{ id: 'user-a' }], []]
        if (sql.includes('COUNT(*) AS activeCount')) return [[{ activeCount: 5 }], []]
        return [[], []]
      }),
    } as unknown as PoolConnection
    const pool = {
      getConnection: vi.fn(async () => connection),
      execute: vi.fn(async () => [{ affectedRows: 1 }, []]),
    } as unknown as Pool
    const repository = new OnSwitchPaymentRepository(pool, 'e'.repeat(64), 5)

    await expect(
      repository.createOperation({
        userId: 'user-a',
        operationType: 'onramp',
        idempotencyKey: 'new-payment-request-001',
        requestFingerprint: 'f'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_PENDING_LIMIT', statusCode: 429 })

    expect(queries).toContain('SELECT id FROM users WHERE id=? FOR UPDATE')
    expect(connection.rollback).toHaveBeenCalledOnce()
    expect(queries.some((query) => query.includes('INSERT INTO payment_operations'))).toBe(false)
    expect(pool.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO security_events'),
      expect.arrayContaining(['user-a', 'payment.onswitch.pending_limit', 'denied']),
    )
  })
})
