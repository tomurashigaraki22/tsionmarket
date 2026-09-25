import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import type { Environment } from '../src/config/env.js'
import {
  OnSwitchClient,
  OnSwitchClientError,
  type OnSwitchGetPath,
  type OnSwitchPostPath,
} from '../src/payments/onswitch/client.js'
import { metricsHandler } from '../src/observability/metrics.js'

const TEST_KEY = 'sandbox-test-secret-not-real'

function makeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeClient(fetchImpl: typeof fetch, timeoutMs = 1000) {
  return new OnSwitchClient({ environment: 'sandbox', serviceKey: TEST_KEY, timeoutMs }, fetchImpl)
}

describe('OnSwitch server client', () => {
  it('uses the fixed HTTPS origin, server-only key header, and refuses redirects', async () => {
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined
    const fetchImpl: typeof fetch = async (input, init) => {
      capturedUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      capturedInit = init
      return makeResponse({ success: true, data: [] })
    }

    const client = makeClient(fetchImpl)
    const result = await client.get('/coverage', { direction: 'OFFRAMP', country: 'NG' })

    expect(result.data).toEqual([])
    const url = new URL(capturedUrl)
    expect(url.origin).toBe('https://api.onswitch.xyz')
    expect(url.pathname).toBe('/coverage')
    expect(url.searchParams.get('direction')).toBe('OFFRAMP')
    expect(url.searchParams.get('country')).toBe('NG')
    expect(new Headers(capturedInit?.headers).get('x-service-key')).toBe(TEST_KEY)
    expect(capturedInit?.redirect).toBe('error')
  })

  it('serializes POST payloads and never includes provider credentials in them', async () => {
    let capturedBody = ''
    let capturedHeaders: Headers | undefined
    const fetchImpl: typeof fetch = async (_input, init) => {
      capturedBody = typeof init?.body === 'string' ? init.body : ''
      capturedHeaders = new Headers(init?.headers)
      return makeResponse({ success: true, data: { rate: 1 } })
    }

    await makeClient(fetchImpl).post('/offramp/quote', {
      amount: 25,
      asset: 'arbitrum:usdc',
      country: 'NG',
    })

    expect(JSON.parse(capturedBody)).toEqual({
      amount: 25,
      asset: 'arbitrum:usdc',
      country: 'NG',
    })
    expect(capturedHeaders?.get('content-type')).toBe('application/json')
    expect(capturedBody).not.toContain(TEST_KEY)
  })

  it('rejects undocumented or provider-wallet endpoints before making a request', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const client = makeClient(fetchImpl)

    await expect(client.get('/wallet/export' as OnSwitchGetPath)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      retryable: false,
    })
    await expect(client.post('/wallet/create' as OnSwitchPostPath, {})).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      retryable: false,
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not send oversized request bodies', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const client = makeClient(fetchImpl)
    const body = { value: 'x'.repeat(130 * 1024) }

    await expect(client.post('/onramp/initiate', body)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      retryable: false,
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    [400, 'PROVIDER_REJECTED', false],
    [429, 'RATE_LIMITED', true],
    [503, 'PROVIDER_UNAVAILABLE', true],
  ] as const)('maps provider HTTP %i without exposing response text', async (status, code, retryable) => {
    const fetchImpl: typeof fetch = async () =>
      new Response('private beneficiary data and provider diagnostics', { status })
    const client = makeClient(fetchImpl)

    await expect(client.get('/asset')).rejects.toMatchObject({
      code,
      statusCode: status,
      retryable,
    })
    try {
      await client.get('/asset')
    } catch (error) {
      expect((error as Error).message).not.toContain('private beneficiary')
      expect(JSON.stringify(error)).not.toContain(TEST_KEY)
    }
  })

  it('maps a provider-level failure envelope without leaking its message', async () => {
    const client = makeClient(async () =>
      makeResponse({ success: false, message: 'Sensitive bank account validation detail' }),
    )

    await expect(client.get('/coverage')).rejects.toMatchObject({
      code: 'PROVIDER_REJECTED',
      statusCode: 200,
      retryable: false,
    })
    try {
      await client.get('/coverage')
    } catch (error) {
      expect((error as Error).message).not.toContain('Sensitive bank account')
    }
  })

  it('rejects malformed envelopes, invalid JSON, and oversized responses', async () => {
    const malformed = makeClient(async () => makeResponse({ success: true }))
    await expect(malformed.get('/asset')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      statusCode: 200,
    })

    const invalidJson = makeClient(async () => new Response('{not json', { status: 200 }))
    await expect(invalidJson.get('/asset')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      statusCode: 200,
    })

    const tooLarge = makeClient(async () => new Response('x'.repeat(257 * 1024), { status: 200 }))
    await expect(tooLarge.get('/asset')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      statusCode: 200,
    })
  })

  it('uses a bounded abort timeout and records a safe provider metric', async () => {
    const fetchImpl: typeof fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    const client = makeClient(fetchImpl, 5)

    await expect(client.get('/coverage')).rejects.toMatchObject({
      code: 'TIMEOUT',
      retryable: true,
    })

    const app = express()
    app.get('/metrics', metricsHandler({ METRICS_ENABLED: true } as Environment))
    const response = await request(app).get('/metrics').expect(200)
    expect(response.text).toMatch(/provider_requests_total_onswitch_GET_coverage_timeout \d+/)
    expect(response.text).not.toContain(TEST_KEY)
  })

  it('classifies unexpected network failures without retaining the thrown error', async () => {
    const client = makeClient(async () => {
      throw new Error(`network failed with ${TEST_KEY}`)
    })

    let caught: unknown
    try {
      await client.get('/coverage')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(OnSwitchClientError)
    expect(caught).toMatchObject({ code: 'NETWORK_ERROR', retryable: true })
    expect(JSON.stringify(caught)).not.toContain(TEST_KEY)
  })
})
