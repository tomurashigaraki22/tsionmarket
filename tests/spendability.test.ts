import { describe, expect, it } from 'vitest'
import { evaluateSpendability } from '../src/portfolio/spendability.js'

describe('spendability policy', () => {
  it('reserves native fees at the exact boundary', () => {
    expect(
      evaluateSpendability({
        sourceBalanceRaw: 110n,
        sellAmountRaw: 100n,
        nativeBalanceRaw: 110n,
        estimatedFeeRaw: 8n,
        feeSafetyBufferRaw: 2n,
        sourceIsNative: true,
      }).spendable,
    ).toBe(true)
    expect(
      evaluateSpendability({
        sourceBalanceRaw: 109n,
        sellAmountRaw: 100n,
        nativeBalanceRaw: 109n,
        estimatedFeeRaw: 8n,
        feeSafetyBufferRaw: 2n,
        sourceIsNative: true,
      }).spendable,
    ).toBe(false)
  })
  it('separates token, gas, and allowance requirements', () => {
    const result = evaluateSpendability({
      sourceBalanceRaw: 100n,
      sellAmountRaw: 100n,
      nativeBalanceRaw: 9n,
      estimatedFeeRaw: 8n,
      feeSafetyBufferRaw: 2n,
      sourceIsNative: false,
      allowanceRaw: 99n,
    })
    expect(result).toMatchObject({
      spendable: false,
      approvalRequired: true,
      reasons: ['INSUFFICIENT_FEE_BALANCE'],
      requiredSourceRaw: '100',
      requiredNativeRaw: '10',
    })
  })
  it('preserves large integer precision', () => {
    const amount = 2n ** 200n
    expect(
      evaluateSpendability({
        sourceBalanceRaw: amount,
        sellAmountRaw: amount,
        nativeBalanceRaw: 10n,
        estimatedFeeRaw: 10n,
        feeSafetyBufferRaw: 0n,
        sourceIsNative: false,
        allowanceRaw: amount,
      }).spendable,
    ).toBe(true)
  })
})
