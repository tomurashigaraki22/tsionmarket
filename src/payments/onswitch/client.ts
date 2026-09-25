import { z } from 'zod'
import { ONSWITCH_API_ORIGIN, type OnSwitchRuntimeConfig } from '../../config/onswitch.js'
import { recordOutboundRequest } from '../../observability/metrics.js'

const GET_PATHS = [
  '/coverage',
  '/asset',
  '/beneficiary/requirement',
  '/beneficiary/fetch',
  '/institution',
  '/institution/lookup',
  '/payment/status',
  '/payment/history',
  '/payment/summary',
  '/webhook/history',
] as const

const POST_PATHS = [
  '/beneficiary/create',
  '/compliance/aml/lookup',
  '/onramp/quote',
  '/onramp/rate',
  '/onramp/initiate',
  '/offramp/quote',
  '/offramp/rate',
  '/offramp/initiate',
  '/swap/quote',
  '/swap/initiate',
  '/payment/confirm',
  '/webhook/resend',
] as const

export type OnSwitchGetPath = (typeof GET_PATHS)[number]
export type OnSwitchPostPath = (typeof POST_PATHS)[number]
export type OnSwitchQuery = Readonly<Record<string, string | number | boolean | undefined>>

const getPathSet = new Set<string>(GET_PATHS)
const postPathSet = new Set<string>(POST_PATHS)
const envelopeSchema = z
  .object({
    success: z.boolean(),
    message: z.string().max(4096).optional(),
    timestamp: z.string().optional(),
    status: z.number().int().optional(),
    data: z.unknown().optional(),
  })
  .passthrough()
  .refine((value) => value.success === false || Object.hasOwn(value, 'data'), {
    message: 'Successful provider response is missing its data field',
  })

export type OnSwitchEnvelope = z.infer<typeof envelopeSchema>

export type OnSwitchClientErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_RESPONSE'
  | 'PROVIDER_REJECTED'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'

/** Safe provider error: never carries a request body, response body, or key. */
export class OnSwitchClientError extends Error {
  constructor(
    readonly code: OnSwitchClientErrorCode,
    readonly statusCode: number | null,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message)
    this.name = 'OnSwitchClientError'
  }
}

const MAX_REQUEST_BYTES = 128 * 1024
const MAX_RESPONSE_BYTES = 256 * 1024

/**
 * Minimal server-only transport for documented payment/catalogue endpoints.
 * It deliberately does not expose Switch wallet create/export/transfer APIs.
 */
export class OnSwitchClient {
  private readonly fetchImpl: typeof fetch

  constructor(
    private readonly config: OnSwitchRuntimeConfig,
    fetchImpl: typeof fetch = globalThis.fetch,
  ) {
    if (!/^[\x21-\x7e]{1,4096}$/.test(config.serviceKey))
      throw new Error('OnSwitch service key is missing or invalid')
    if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1)
      throw new Error('OnSwitch timeout must be a positive integer')
    this.fetchImpl = fetchImpl
  }

  get(path: OnSwitchGetPath, query?: OnSwitchQuery): Promise<OnSwitchEnvelope> {
    return this.request('GET', path, query)
  }

  post(path: OnSwitchPostPath, body: Record<string, unknown>): Promise<OnSwitchEnvelope> {
    return this.request('POST', path, undefined, body)
  }

  private async request(
    method: 'GET' | 'POST',
    path: OnSwitchGetPath | OnSwitchPostPath,
    query?: OnSwitchQuery,
    body?: Record<string, unknown>,
  ): Promise<OnSwitchEnvelope> {
    const allowed = method === 'GET' ? getPathSet : postPathSet
    if (!allowed.has(path)) {
      throw new OnSwitchClientError('INVALID_REQUEST', null, false, 'OnSwitch endpoint is not allowlisted')
    }

    const url = new URL(path, ONSWITCH_API_ORIGIN)
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value))
      }
    }

    let serializedBody: string | undefined
    if (method === 'POST') {
      try {
        serializedBody = JSON.stringify(body)
      } catch {
        throw new OnSwitchClientError(
          'INVALID_REQUEST',
          null,
          false,
          'OnSwitch request body could not be serialized',
        )
      }
      if (!serializedBody || Buffer.byteLength(serializedBody, 'utf8') > MAX_REQUEST_BYTES) {
        throw new OnSwitchClientError(
          'INVALID_REQUEST',
          null,
          false,
          'OnSwitch request body is empty or too large',
        )
      }
    }

    const headers = new Headers({ accept: 'application/json', 'x-service-key': this.config.serviceKey })
    if (serializedBody !== undefined) headers.set('content-type', 'application/json')

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs)
    timeout.unref?.()
    const startedAt = performance.now()
    let metricStatus: number | string = 'network_error'

    try {
      const response = await this.fetchImpl(url, {
        method,
        headers,
        ...(serializedBody !== undefined ? { body: serializedBody } : {}),
        signal: controller.signal,
        // Never forward x-service-key to an unexpected redirect target.
        redirect: 'error',
      })
      metricStatus = response.status
      const responseText = await readBoundedText(response, MAX_RESPONSE_BYTES)

      if (!response.ok) {
        if (response.status === 429) {
          throw new OnSwitchClientError('RATE_LIMITED', response.status, true, 'OnSwitch rate limit reached')
        }
        if (response.status >= 500) {
          throw new OnSwitchClientError(
            'PROVIDER_UNAVAILABLE',
            response.status,
            true,
            'OnSwitch is temporarily unavailable',
          )
        }
        throw new OnSwitchClientError(
          'PROVIDER_REJECTED',
          response.status,
          false,
          'OnSwitch rejected the request',
        )
      }

      let parsedJson: unknown
      try {
        parsedJson = JSON.parse(responseText) as unknown
      } catch {
        throw new OnSwitchClientError(
          'INVALID_RESPONSE',
          response.status,
          false,
          'OnSwitch returned invalid JSON',
        )
      }

      const envelope = envelopeSchema.safeParse(parsedJson)
      if (!envelope.success) {
        throw new OnSwitchClientError(
          'INVALID_RESPONSE',
          response.status,
          false,
          'OnSwitch returned an invalid response envelope',
        )
      }
      if (!envelope.data.success) {
        throw new OnSwitchClientError(
          'PROVIDER_REJECTED',
          response.status,
          false,
          'OnSwitch could not complete the request',
        )
      }
      return envelope.data
    } catch (error) {
      if (error instanceof OnSwitchClientError) {
        metricStatus = error.code === 'TIMEOUT' ? 'timeout' : (error.statusCode ?? error.code)
        throw error
      }
      if (controller.signal.aborted) {
        metricStatus = 'timeout'
        throw new OnSwitchClientError('TIMEOUT', null, true, 'OnSwitch request timed out')
      }
      metricStatus = 'network_error'
      throw new OnSwitchClientError('NETWORK_ERROR', null, true, 'Could not reach OnSwitch')
    } finally {
      clearTimeout(timeout)
      recordOutboundRequest('onswitch', method, path, metricStatus, performance.now() - startedAt)
    }
  }
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const lengthHeader = response.headers.get('content-length')
  if (lengthHeader && /^\d+$/.test(lengthHeader) && Number(lengthHeader) > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new OnSwitchClientError(
      'INVALID_RESPONSE',
      response.status,
      false,
      'OnSwitch response exceeded the size limit',
    )
  }

  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let receivedBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      receivedBytes += value.byteLength
      if (receivedBytes > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new OnSwitchClientError(
          'INVALID_RESPONSE',
          response.status,
          false,
          'OnSwitch response exceeded the size limit',
        )
      }
      chunks.push(decoder.decode(value, { stream: true }))
    }
    chunks.push(decoder.decode())
    return chunks.join('')
  } finally {
    reader.releaseLock()
  }
}
