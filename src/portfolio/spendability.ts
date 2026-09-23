export type SpendabilityInput = {
  sourceBalanceRaw: bigint
  sellAmountRaw: bigint
  nativeBalanceRaw: bigint
  estimatedFeeRaw: bigint
  feeSafetyBufferRaw: bigint
  sourceIsNative: boolean
  allowanceRaw?: bigint
}

export type Spendability = {
  spendable: boolean
  approvalRequired: boolean
  requiredSourceRaw: string
  requiredNativeRaw: string
  reasons: Array<'INSUFFICIENT_ASSET_BALANCE' | 'INSUFFICIENT_FEE_BALANCE'>
}

/** Precision-safe policy used by quote/intent phases; no floating point values enter this boundary. */
export function evaluateSpendability(input: SpendabilityInput): Spendability {
  const requiredNative = input.estimatedFeeRaw + input.feeSafetyBufferRaw
  const sourceRequired = input.sourceIsNative ? input.sellAmountRaw + requiredNative : input.sellAmountRaw
  const reasons: Spendability['reasons'] = []
  if (input.sourceBalanceRaw < sourceRequired) reasons.push('INSUFFICIENT_ASSET_BALANCE')
  if (!input.sourceIsNative && input.nativeBalanceRaw < requiredNative)
    reasons.push('INSUFFICIENT_FEE_BALANCE')
  return {
    spendable: reasons.length === 0,
    approvalRequired: !input.sourceIsNative && (input.allowanceRaw ?? 0n) < input.sellAmountRaw,
    requiredSourceRaw: sourceRequired.toString(),
    requiredNativeRaw: requiredNative.toString(),
    reasons,
  }
}
