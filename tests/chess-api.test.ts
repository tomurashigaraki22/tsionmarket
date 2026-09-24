import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import { parseEnvironment } from '../src/config/env.js'
import type { ChessRepository } from '../src/arcade/ChessRepository.js'

const environment = parseEnvironment({
  NODE_ENV: 'test',
  MYSQL_HOST: 'localhost',
  MYSQL_DATABASE: 'tsionmarket_test',
  MYSQL_USER: 'app',
  MYSQL_PASSWORD: 'password',
  MYSQL_MIGRATION_USER: 'migration',
  MYSQL_MIGRATION_PASSWORD: 'password',
  CORS_ALLOWED_ORIGINS: 'https://app.tsionmarket.test',
})

const identity = {
  userId: '123e4567-e89b-42d3-a456-426614174000',
  sessionId: '223e4567-e89b-42d3-a456-426614174000',
  email: 'player@example.test',
  tokenVersion: 1,
}
const inviteToken = 'B'.repeat(43)
const testMatchId: `${string}-${string}-${string}-${string}-${string}` =
  '323e4567-e89b-42d3-a456-426614174000'

function testApp(chess: Partial<ChessRepository>) {
  const authService = {
    authenticate: vi.fn(async () => identity),
  }
  return createApp({
    environment,
    readinessCheck: async () => ({ ready: true, checks: { mysql: 'ready', migrations: 'current' } }),
    authService: authService as never,
    chessRepository: chess as ChessRepository,
  })
}

describe('authenticated Chess API', () => {
  it('requires sign-in to create an invitation', async () => {
    const createInvite = vi.fn()
    const app = testApp({ createInvite })
    const response = await request(app).post('/v1/arcade/chess/invites').send({ timeControlSeconds: 600 })
    expect(response.status).toBe(401)
    expect(createInvite).not.toHaveBeenCalled()
  })

  it('creates only a no-stakes invitation and uses the signed-in account', async () => {
    const createInvite = vi.fn(async (_userId: string, _seconds: number) => ({
      matchId: testMatchId,
      inviteToken,
      expiresAt: '2026-09-25T12:00:00.000Z',
      timeControlSeconds: 600,
      stake: null,
    }))
    const app = testApp({ createInvite })
    const response = await request(app)
      .post('/v1/arcade/chess/invites')
      .set('authorization', 'Bearer authenticated-test-token')
      .send({ timeControlSeconds: 600 })
    expect(response.status).toBe(201)
    expect(createInvite).toHaveBeenCalledWith(identity.userId, 600)
    expect(response.body.data).toMatchObject({ stake: null, timeControlSeconds: 600 })
  })

  it('rejects stake or network fields instead of silently accepting unstated terms', async () => {
    const createInvite = vi.fn()
    const app = testApp({ createInvite })
    const response = await request(app)
      .post('/v1/arcade/chess/invites')
      .set('authorization', 'Bearer authenticated-test-token')
      .send({ timeControlSeconds: 600, stake: '1', networkId: 'intertrain' })
    expect(response.status).toBe(400)
    expect(createInvite).not.toHaveBeenCalled()
  })

  it('sends invitation capabilities in the request body, not logged route paths', async () => {
    const invitePreview = vi.fn(async (_token: string, _userId: string) => ({
      matchId: '323e4567-e89b-42d3-a456-426614174000',
      status: 'waiting' as const,
      isCreator: false,
      timeControlSeconds: 600,
      stake: null,
      terms: '10-minute clock · no entry fee · no prize or payout',
    }))
    const app = testApp({ invitePreview })
    const response = await request(app)
      .post('/v1/arcade/chess/invites/preview')
      .set('authorization', 'Bearer authenticated-test-token')
      .send({ token: inviteToken })
    expect(response.status).toBe(200)
    expect(invitePreview).toHaveBeenCalledWith(inviteToken, identity.userId)
    expect(response.body.data.isCreator).toBe(false)
    expect(response.request.url).not.toContain(inviteToken)
  })

  it('rejects malformed client move coordinates before repository execution', async () => {
    const move = vi.fn()
    const app = testApp({ move })
    const response = await request(app)
      .post('/v1/arcade/chess/matches/323e4567-e89b-42d3-a456-426614174000/moves')
      .set('authorization', 'Bearer authenticated-test-token')
      .send({ expectedVersion: 0, from: 'a9', to: 'a1' })
    expect(response.status).toBe(400)
    expect(move).not.toHaveBeenCalled()
  })

  it('lists only the signed-in player’s saved match summaries', async () => {
    const listForUser = vi.fn(async (_userId: string, _limit: number) => ({ items: [] }))
    const app = testApp({ listForUser })
    const response = await request(app)
      .get('/v1/arcade/chess/matches')
      .set('authorization', 'Bearer authenticated-test-token')
    expect(response.status).toBe(200)
    expect(listForUser).toHaveBeenCalledWith(identity.userId, 20)
    expect(response.body.data.items).toEqual([])
  })
})
