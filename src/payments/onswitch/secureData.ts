import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { AppError } from '../../utils/errors.js'

const ENVELOPE_MARKER = 'onswitch-aes-256-gcm-v1'
const KEY_BYTES = 32

type EncryptedEnvelope = {
  _encrypted: typeof ENVELOPE_MARKER
  iv: string
  tag: string
  ciphertext: string
}

/** Encrypts provider instructions containing one-time bank or mobile-money details. */
export function encryptPaymentInstructions(
  value: Record<string, unknown>,
  encryptionKeyHex: string | undefined,
): EncryptedEnvelope {
  const key = parseKey(encryptionKeyHex)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return {
    _encrypted: ENVELOPE_MARKER,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
}

/** Reads encrypted records and permits pre-encryption rows during a safe migration window. */
export function decryptPaymentInstructions(value: unknown, encryptionKeyHex: string | undefined): unknown {
  if (!isEncryptedPaymentInstructions(value)) return value
  try {
    const key = parseKey(encryptionKeyHex)
    const iv = Buffer.from(value.iv, 'base64')
    const tag = Buffer.from(value.tag, 'base64')
    const ciphertext = Buffer.from(value.ciphertext, 'base64')
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > 128 * 1024)
      throw new Error('Invalid encrypted instruction envelope')
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
    return JSON.parse(plaintext) as unknown
  } catch {
    // Do not leak cryptographic errors, ciphertext, or details from stored data.
    throw new AppError('PAYMENT_DATA_UNAVAILABLE', 'Payment instructions are temporarily unavailable', 503)
  }
}

function parseKey(value: string | undefined): Buffer {
  if (!value || !/^[a-fA-F0-9]{64}$/.test(value))
    throw new AppError('PAYMENT_DATA_UNAVAILABLE', 'Payment data encryption is not configured', 503)
  const key = Buffer.from(value, 'hex')
  if (key.length !== KEY_BYTES)
    throw new AppError('PAYMENT_DATA_UNAVAILABLE', 'Payment data encryption is not configured', 503)
  return key
}

export function isEncryptedPaymentInstructions(value: unknown): value is EncryptedEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    '_encrypted' in value &&
    value._encrypted === ENVELOPE_MARKER &&
    'iv' in value &&
    typeof value.iv === 'string' &&
    'tag' in value &&
    typeof value.tag === 'string' &&
    'ciphertext' in value &&
    typeof value.ciphertext === 'string'
  )
}
