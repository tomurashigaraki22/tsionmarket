import { describe, expect, it } from 'vitest'
import { detectedSecretKinds } from '../scripts/check-secrets.mjs'

describe('secret scanner', () => {
  it('detects literal OnSwitch keys without printing their values', () => {
    const sandboxKeyName = ['ONSWITCH', 'SANDBOX', 'SERVICE', 'KEY'].join('_')
    const liveKeyName = ['ONSWITCH', 'LIVE', 'SERVICE', 'KEY'].join('_')
    const syntheticKeyValue = `sandbox_${'0123456789'.repeat(3)}`
    expect(detectedSecretKinds(`${sandboxKeyName}="${syntheticKeyValue}"`)).toContain('onswitch-service-key')
    expect(detectedSecretKinds(`${liveKeyName}: '${syntheticKeyValue}'`)).toContain('onswitch-service-key')
  })

  it('ignores blank values, placeholders, environment references, and schema definitions', () => {
    const safe = [
      'ONSWITCH_SANDBOX_SERVICE_KEY=',
      'ONSWITCH_SANDBOX_SERVICE_KEY=${ONSWITCH_SANDBOX_SERVICE_KEY:-}',
      "ONSWITCH_SANDBOX_SERVICE_KEY: 'sandbox-test-secret-not-real'",
      'ONSWITCH_SANDBOX_SERVICE_KEY: z.string().optional(),',
    ].join('\n')
    expect(detectedSecretKinds(safe)).not.toContain('onswitch-service-key')
  })
})
