import { bech32m } from '@scure/base'

type RecordValue = Record<string, unknown>

const asRecord = (value: unknown): RecordValue | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as RecordValue) : null

function rawInteger(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value >= 0n ? value : null
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value)
  return null
}

/**
 * Whether the node's answer is about the address we asked for.
 *
 * The node reports an account under its own `wsk` prefix, while we hold and
 * display it as `mna`. Same 21 address bytes, different prefix and therefore
 * different checksum, so comparing the strings rejects a correct answer.
 * Compare the decoded bytes instead; an undecodable or different address still
 * fails.
 */
export function isSameIntertrainAddress(reported: string, requested: string): boolean {
  try {
    const a = bech32m.decodeToBytes(reported.trim())
    const b = bech32m.decodeToBytes(requested.trim())
    return Buffer.from(a.bytes).equals(Buffer.from(b.bytes))
  } catch {
    return reported.trim().toLowerCase() === requested.trim().toLowerCase()
  }
}

export function isExpectedIntertrainChain(value: unknown): boolean {
  const info = asRecord(value)
  const asset = asRecord(info?.native_asset)
  return info?.chain_id === 'intertrain-1' && asset?.symbol === 'WSK' && rawInteger(asset.decimals) === 6n
}

export function parseIntertrainNativeBalance(value: unknown): string | null {
  const account = asRecord(value)
  const amount = rawInteger(account?.balance)
  return amount === null ? null : amount.toString()
}

function isOneToOneRate(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return /^1\s+USDC\s*=\s*1\s+(?:WSK|MNA)$/i.test(value.trim())
}

/**
 * Price WSK at $1 only if a live reserve snapshot says the exact 1:1 rate is
 * active, unpaused, fully backed, and backed by a non-zero requirement.
 */
export function isIntertrainReservePriceable(value: unknown): boolean {
  const status = asRecord(value)
  if (!status || status.paused !== false || status.collateralized !== true || !isOneToOneRate(status.rate))
    return false
  const supply = rawInteger(status.total_mna_supply)
  const redeemable = rawInteger(status.reserve_backed_mna_minted)
  const reserves = rawInteger(status.current_reserves_total_usd)
  const required = rawInteger(status.required_reserve_usd)
  return (
    supply !== null &&
    supply > 0n &&
    redeemable !== null &&
    redeemable >= supply &&
    reserves !== null &&
    required !== null &&
    required > 0n &&
    reserves >= required
  )
}
