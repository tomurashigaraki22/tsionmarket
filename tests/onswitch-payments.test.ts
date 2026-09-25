import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { parseEnvironment } from '../src/config/env.js'
import type { OnSwitchRuntimeConfig } from '../src/config/onswitch.js'
import { OnSwitchPaymentsService } from '../src/payments/onswitch/service.js'
import {
  canTransitionPayment,
  isPaymentTerminal,
  normalizeProviderStatus,
} from '../src/payments/onswitch/payments.js'
import { retryDelayMs, type OnSwitchPaymentRepository } from '../src/payments/onswitch/repository.js'
import { OnSwitchWebhookService } from '../src/payments/onswitch/webhook.js'
import { OnSwitchWorker } from '../src/payments/onswitch/worker.js'
import type { OnSwitchClient } from '../src/payments/onswitch/client.js'
import { AppError } from '../src/utils/errors.js'

const validEnvironment = {
  NODE_ENV: 'test',
  MYSQL_HOST: 'localhost',
  MYSQL_DATABASE: 'payments_test',
  MYSQL_USER: 'app',
  MYSQL_PASSWORD: 'password',
  MYSQL_MIGRATION_USER: 'migration',
  MYSQL_MIGRATION_PASSWORD: 'password',
  ONSWITCH_ENABLED: 'true',
  ONSWITCH_ENVIRONMENT: 'sandbox',
  ONSWITCH_SANDBOX_SERVICE_KEY: 'sandbox-secret-not-real',
  ONSWITCH_IDEMPOTENCY_SECRET: 'idempotency-secret-with-at-least-32-chars',
}

describe('OnSwitch payment lifecycle primitives', () => {
  it('normalizes documented provider statuses and preserves unknown values as unknown', () => {
    expect(normalizeProviderStatus('AWAITING_DEPOSIT')).toBe('awaiting_chain')
    expect(normalizeProviderStatus('PROCESSING')).toBe('processing')
    expect(normalizeProviderStatus('COMPLETED')).toBe('completed')
    expect(normalizeProviderStatus('REVERSED')).toBe('reversed')
    expect(normalizeProviderStatus('new-vendor-state')).toBe('unknown')
  })

  it('allows forward transitions and rejects out-of-order regression from terminal state', () => {
    expect(canTransitionPayment('awaiting_chain', 'processing')).toBe(true)
    expect(canTransitionPayment('processing', 'completed')).toBe(true)
    expect(canTransitionPayment('completed', 'reversed')).toBe(true)
    expect(canTransitionPayment('completed', 'processing')).toBe(false)
    expect(canTransitionPayment('failed', 'completed')).toBe(false)
    expect(isPaymentTerminal('completed')).toBe(true)
    expect(isPaymentTerminal('manual_review')).toBe(false)
  })

  it('uses capped exponential backoff', () => {
    expect(retryDelayMs(1)).toBe(10_000)
    expect(retryDelayMs(3)).toBe(40_000)
    expect(retryDelayMs(20)).toBe(30 * 60_000)
  })

  it('HMAC-fingerprints material idempotency fields without persisting their values', async () => {
    const captured: Array<{ requestFingerprint: string; idempotencyKey: string }> = []
    const repository = {
      createOperation: vi.fn(async (input: { requestFingerprint: string; idempotencyKey: string }) => {
        captured.push(input)
        return { id: 'payment-id', existing: false }
      }),
    } as unknown as OnSwitchPaymentRepository
    const service = new OnSwitchPaymentsService(repository, parseEnvironment(validEnvironment))
    const input = { operationType: 'offramp' as const, country: 'NG', fiatCurrency: 'NGN' }

    await service.createOperation('user-id', 'request-key-0000001', input, {
      beneficiary: { account_number: '1234567890', bank_code: '058' },
      amount: '25.00',
    })
    await service.createOperation('user-id', 'request-key-0000001', input, {
      amount: '25.00',
      beneficiary: { bank_code: '058', account_number: '1234567890' },
    })
    await service.createOperation('user-id', 'request-key-0000001', input, {
      amount: '26.00',
      beneficiary: { bank_code: '058', account_number: '1234567890' },
    })

    expect(captured[0]?.requestFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(captured[0]?.requestFingerprint).toBe(captured[1]?.requestFingerprint)
    expect(captured[1]?.requestFingerprint).not.toBe(captured[2]?.requestFingerprint)
    expect(JSON.stringify(captured)).not.toContain('1234567890')
  })

  it('confirms submitted off-ramp transactions and reconciles status using bounded worker APIs', async () => {
    const reference = 'e6ef587e-d03d-44d0-a07a-a7e8a7aaabc1'
    const repository = {
      processWebhookBatch: vi.fn(async () => 1),
      claimConfirmationBatch: vi.fn(async () => [
        {
          id: 'payment-id',
          operationId: 'payment-id',
          providerReference: reference,
          chainTxHash: `0x${'a'.repeat(64)}`,
          attempts: 0,
        },
      ]),
      recordConfirmationAttempt: vi.fn(async () => undefined),
      claimReconciliationBatch: vi.fn(async () => [
        { id: 'payment-id', operationId: 'payment-id', providerReference: reference, attempts: 0 },
      ]),
      recordReconciliation: vi.fn(async () => undefined),
    } as unknown as OnSwitchPaymentRepository
    const client = {
      post: vi.fn(async () => ({ success: true, data: { status: 'PROCESSING' } })),
      get: vi.fn(async () => ({ success: true, data: { reference, status: 'PROCESSING' } })),
    } as unknown as OnSwitchClient
    const worker = new OnSwitchWorker(repository, client, parseEnvironment(validEnvironment))

    await worker.tick()

    expect(repository.processWebhookBatch).toHaveBeenCalledOnce()
    expect(repository.recordConfirmationAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: 'payment-id',
        acknowledged: true,
        providerStatus: 'PROCESSING',
      }),
    )
    expect(client.get).toHaveBeenCalledWith('/payment/status', { reference })
    expect(repository.recordReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'payment-id', providerStatus: 'PROCESSING' }),
    )
  })

  it('does not accept a provider status response for a different payment reference', async () => {
    const repository = {
      processWebhookBatch: vi.fn(async () => 0),
      claimConfirmationBatch: vi.fn(async () => []),
      recordConfirmationAttempt: vi.fn(async () => undefined),
      claimReconciliationBatch: vi.fn(async () => [
        {
          id: 'payment-id',
          operationId: 'payment-id',
          providerReference: 'e6ef587e-d03d-44d0-a07a-a7e8a7aaabc1',
          attempts: 0,
        },
      ]),
      recordReconciliation: vi.fn(async () => undefined),
    } as unknown as OnSwitchPaymentRepository
    const client = {
      post: vi.fn(),
      get: vi.fn(async () => ({
        success: true,
        data: { reference: '69e8e664-b9fe-a9f9-e6dc-3cbb00000000', status: 'COMPLETED' },
      })),
    } as unknown as OnSwitchClient
    const worker = new OnSwitchWorker(repository, client, parseEnvironment(validEnvironment))

    await worker.tick()

    expect(repository.recordReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'payment-id', failureCode: 'WORKER_ERROR' }),
    )
  })
})

describe('OnSwitch webhook verification', () => {
  const serviceKey = 'sandbox-webhook-test-key'
  const runtime: OnSwitchRuntimeConfig = {
    environment: 'sandbox',
    serviceKey,
    timeoutMs: 1000,
  }
  const event = {
    success: true,
    data: {
      reference: 'e6ef587e-d03d-44d0-a07a-a7e8a7aaabc1',
      type: 'OFFRAMP',
      status: 'PROCESSING',
    },
  }

  function signature(body: Buffer) {
    return createHmac('sha256', serviceKey).update(body).digest('hex')
  }

  it('verifies exact raw bytes and persists only a digest plus normalized event metadata', async () => {
    const stored: Array<{
      eventDigest: string
      providerReference: string
      providerType: string
      providerStatus: string
      deliveryTimestamp: string | null
    }> = []
    const storeVerifiedWebhook = vi.fn(async (input: (typeof stored)[number]) => {
      stored.push(input)
      return { duplicate: false }
    })
    const service = new OnSwitchWebhookService(runtime, { storeVerifiedWebhook })
    const raw = Buffer.from(JSON.stringify(event))
    const result = await service.receive(raw, signature(raw), '2026-09-25T18:00:00Z')

    expect(result).toEqual({ accepted: true, duplicate: false })
    expect(stored).toHaveLength(1)
    expect(stored[0]?.eventDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(stored[0]).toMatchObject({
      providerReference: event.data.reference,
      providerType: 'OFFRAMP',
      providerStatus: 'PROCESSING',
      deliveryTimestamp: '2026-09-25T18:00:00Z',
    })
    expect(stored[0]).not.toHaveProperty('data')
    expect(stored[0]).not.toHaveProperty('rawBody')
  })

  it('rejects missing, malformed, or mismatched signatures', async () => {
    const repository = { storeVerifiedWebhook: vi.fn(async () => ({ duplicate: false })) }
    const service = new OnSwitchWebhookService(runtime, repository)
    const raw = Buffer.from(JSON.stringify(event))
    await expect(service.receive(raw, undefined, undefined)).rejects.toMatchObject({ statusCode: 401 })
    await expect(service.receive(raw, 'not-a-signature', undefined)).rejects.toMatchObject({
      statusCode: 401,
    })
    await expect(
      service.receive(Buffer.from(`${raw.toString()} `), signature(raw), undefined),
    ).rejects.toMatchObject({
      statusCode: 401,
    })
    expect(repository.storeVerifiedWebhook).not.toHaveBeenCalled()
  })

  it('rejects malformed events after signature verification and never trusts unsigned timestamp for replay', async () => {
    const stored: Array<{
      eventDigest: string
      providerReference: string
      providerType: string
      providerStatus: string
      deliveryTimestamp: string | null
    }> = []
    const storeVerifiedWebhook = vi.fn(async (input: (typeof stored)[number]) => {
      stored.push(input)
      return { duplicate: true }
    })
    const service = new OnSwitchWebhookService(runtime, { storeVerifiedWebhook })
    const malformed = Buffer.from('{"success":true,"data":{"reference":"not-a-uuid"}}')
    await expect(service.receive(malformed, signature(malformed), undefined)).rejects.toMatchObject({
      statusCode: 400,
    })

    const raw = Buffer.from(JSON.stringify(event))
    const first = await service.receive(raw, signature(raw), '2026-09-25T18:00:00Z')
    const replay = await service.receive(raw, signature(raw), '2099-01-01T00:00:00Z')
    expect(first.duplicate).toBe(true)
    expect(replay.duplicate).toBe(true)
    expect(storeVerifiedWebhook).toHaveBeenCalledTimes(2)
    expect(stored[0]?.eventDigest).toBe(stored[1]?.eventDigest)
  })

  it('fails closed when a signed callback references no local payment', async () => {
    const repository = {
      storeVerifiedWebhook: vi.fn(async () => {
        throw new AppError('PAYMENT_NOT_FOUND', 'Payment reference not found', 404)
      }),
    }
    const service = new OnSwitchWebhookService(runtime, repository)
    const raw = Buffer.from(JSON.stringify(event))
    await expect(service.receive(raw, signature(raw), undefined)).rejects.toMatchObject({
      code: 'PAYMENT_NOT_FOUND',
      statusCode: 404,
    })
  })

  it('does not accept callbacks while provider integration is disabled', async () => {
    const service = new OnSwitchWebhookService(null, { storeVerifiedWebhook: vi.fn() })
    const raw = Buffer.from(JSON.stringify(event))
    await expect(service.receive(raw, signature(raw), undefined)).rejects.toMatchObject({ statusCode: 503 })
  })
})
