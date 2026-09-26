import { z } from 'zod'
import { ONSWITCH_API_ORIGIN, type OnSwitchRuntimeConfig } from '../../config/onswitch.js'
import { recordOutboundRequest } from '../../observability/metrics.js'

const GET_PATHS = [
  '/coverage',
  '/asset',
  '/beneficiary/requirement',
  '/beneficiary/fetch',
  '/institution',
  '/payment/status',
  '/payment/history',
  '/payment/summary',
  '/webhook/history',
] as const

const POST_PATHS = [
  '/beneficiary/create',
  '/compliance/aml/lookup',
  '/institution/lookup',
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

/** Provider errors carry only bounded, redacted diagnostics; never raw payloads or keys. */
export class OnSwitchClientError extends Error {
  constructor(
    readonly code: OnSwitchClientErrorCode,
    readonly statusCode: number | null,
    readonly retryable: boolean,
    message: string,
    readonly providerCode: string | null = null,
    readonly providerMessage: string | null = null,
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
        const diagnostic = extractProviderDiagnostic(responseText, body)
        if (response.status === 429) {
          throw new OnSwitchClientError(
            'RATE_LIMITED',
            response.status,
            true,
            'OnSwitch rate limit reached',
            diagnostic.code,
            diagnostic.message,
          )
        }
        if (response.status >= 500) {
          throw new OnSwitchClientError(
            'PROVIDER_UNAVAILABLE',
            response.status,
            true,
            'OnSwitch is temporarily unavailable',
            diagnostic.code,
            diagnostic.message,
          )
        }
        throw new OnSwitchClientError(
          'PROVIDER_REJECTED',
          response.status,
          false,
          'OnSwitch rejected the request',
          diagnostic.code,
          diagnostic.message,
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
        const diagnostic = extractProviderDiagnostic(responseText, body)
        throw new OnSwitchClientError(
          'PROVIDER_REJECTED',
          response.status,
          false,
          'OnSwitch could not complete the request',
          diagnostic.code,
          diagnostic.message,
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

function extractProviderDiagnostic(
  responseText: string,
  requestBody: Record<string, unknown> | undefined,
): { code: string | null; message: string | null } {
  let parsed: unknown
  try {
    parsed = JSON.parse(responseText) as unknown
  } catch {
    return { code: null, message: null }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { code: null, message: null }

  const record = parsed as Record<string, unknown>
  const nestedError =
    record.error && typeof record.error === 'object' && !Array.isArray(record.error)
      ? (record.error as Record<string, unknown>)
      : null
  const code = safeProviderCode(record.code ?? nestedError?.code)
  const rawMessage =
    typeof record.message === 'string'
      ? record.message
      : typeof nestedError?.message === 'string'
        ? nestedError.message
        : null

  return {
    code,
    message: rawMessage ? redactProviderMessage(rawMessage, requestBody) : null,
  }
}

function safeProviderCode(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const code = value.trim()
  return /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(code) ? code.toUpperCase() : null
}

function redactProviderMessage(
  input: string,
  requestBody: Record<string, unknown> | undefined,
): string | null {
  const privateValues: string[] = []
  if (requestBody) collectSensitiveRequestValues(requestBody, '', privateValues)

  const withoutControlCharacters = [...input]
    .map((character) => {
      const codePoint = character.charCodeAt(0)
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? ' ' : character
    })
    .join('')
  let message = withoutControlCharacters.replace(/\s+/g, ' ').trim()
  for (const value of [...new Set(privateValues)].sort((left, right) => right.length - left.length)) {
    if (value.length < 3) continue
    message = message.replace(new RegExp(escapeRegExp(value), 'gi'), '[redacted]')
  }

  message = message
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted]')
    .replace(/\b0x[a-f0-9]{40}\b/gi, '[redacted]')
    .replace(/\b[A-HJ-NP-Za-km-z1-9]{32,64}\b/g, '[redacted]')
    .replace(/\b\+?\d[\d ()-]{8,}\d\b/g, '[redacted]')
    .slice(0, 400)
    .trim()

  return message || null
}

function collectSensitiveRequestValues(value: unknown, key: string, collected: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectSensitiveRequestValues(item, key, collected)
    return
  }
  if (value && typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value))
      collectSensitiveRequestValues(childValue, childKey, collected)
    return
  }
  if (
    /name|account|wallet|address|phone|email|mobile|recipient|beneficiary|reference|idempotency|narration|reason|amount/i.test(
      key,
    ) &&
    (typeof value === 'string' || typeof value === 'number')
  ) {
    collected.push(String(value).trim())
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
