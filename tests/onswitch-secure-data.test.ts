import { describe, expect, it } from 'vitest'
import {
  decryptPaymentInstructions,
  encryptPaymentInstructions,
} from '../src/payments/onswitch/secureData.js'

const key = 'f'.repeat(64)

describe('OnSwitch at-rest instruction protection', () => {
  it('encrypts provider payment instructions and round-trips them with the configured key', () => {
    const instructions = { deposit: { accountNumber: '1234567890', notes: ['one-time account'] } }
    const encrypted = encryptPaymentInstructions(instructions, key)

    expect(JSON.stringify(encrypted)).not.toContain('1234567890')
    expect(decryptPaymentInstructions(encrypted, key)).toEqual(instructions)
  })

  it('fails closed if ciphertext is altered or the wrong key is supplied', () => {
    const encrypted = encryptPaymentInstructions({ deposit: { accountNumber: '1234567890' } }, key)
    expect(() => decryptPaymentInstructions(encrypted, 'a'.repeat(64))).toThrow(
      'Payment instructions are temporarily unavailable',
    )
    expect(() => decryptPaymentInstructions({ ...encrypted, ciphertext: 'AA==' }, key)).toThrow(
      'Payment instructions are temporarily unavailable',
    )
  })

  it('accepts legacy plaintext rows only for backward-compatible reads', () => {
    expect(decryptPaymentInstructions({ deposit: { amount: '10' } }, key)).toEqual({
      deposit: { amount: '10' },
    })
    expect(() => encryptPaymentInstructions({ deposit: {} }, undefined)).toThrow(
      'Payment data encryption is not configured',
    )
  })
})
