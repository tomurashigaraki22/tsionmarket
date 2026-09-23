import { describe, expect, it, vi } from 'vitest'
import { IntentService } from '../src/trading/IntentService.js'

describe('intent idempotency binding', () => {
  it('returns an identical retry and rejects key reuse for another quote', async () => {
    const existing = {
      id: 'intent-1',
      quoteId: 'quote-1',
      accountId: 'account-1',
      payloadVersion: 1,
    }
    const repo = {
      existingIntent: vi.fn().mockResolvedValue(existing),
    }
    const service = new IntentService(repo as never, {} as never, {} as never)
    await expect(
      service.create('user-1', {
        quoteId: 'quote-1',
        idempotencyKey: 'stable-key',
      }),
    ).resolves.toEqual({ intent: existing, existing: true })
    await expect(
      service.create('user-1', {
        quoteId: 'quote-2',
        idempotencyKey: 'stable-key',
      }),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
      statusCode: 409,
    })
  })
})
