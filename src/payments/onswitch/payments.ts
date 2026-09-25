export const PAYMENT_STATUSES = [
  'created',
  'quoted',
  'initiating',
  'awaiting_fiat',
  'awaiting_chain',
  'chain_submitted',
  'processing',
  'completed',
  'failed',
  'expired',
  'blocked',
  'scheduled',
  'reversed',
  'unknown',
  'manual_review',
] as const

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number]
export type PaymentOperationType = 'onramp' | 'offramp'
export type PaymentEventSource = 'local' | 'webhook' | 'reconciliation' | 'confirmation'

const providerStatuses: Record<string, PaymentStatus> = {
  AWAITING_DEPOSIT: 'awaiting_chain',
  AWAITING_PAYMENT: 'awaiting_fiat',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  SUCCESS: 'completed',
  FAILED: 'failed',
  EXPIRED: 'expired',
  BLOCKED: 'blocked',
  SCHEDULED: 'scheduled',
  REVERSED: 'reversed',
}

export function normalizeProviderStatus(value: string, operationType?: PaymentOperationType): PaymentStatus {
  const normalized = value.trim().toUpperCase()
  if (normalized === 'AWAITING_DEPOSIT' && operationType === 'onramp') return 'awaiting_fiat'
  return providerStatuses[normalized] ?? 'unknown'
}

export function isPaymentStatus(value: string): value is PaymentStatus {
  return (PAYMENT_STATUSES as readonly string[]).includes(value)
}

const allowedNext: Record<PaymentStatus, ReadonlySet<PaymentStatus>> = {
  created: new Set(['quoted', 'initiating', 'failed', 'expired', 'unknown', 'manual_review']),
  quoted: new Set(['initiating', 'failed', 'expired', 'unknown', 'manual_review']),
  initiating: new Set([
    'awaiting_fiat',
    'awaiting_chain',
    'processing',
    'completed',
    'failed',
    'expired',
    'blocked',
    'scheduled',
    'unknown',
    'manual_review',
  ]),
  awaiting_fiat: new Set([
    'processing',
    'completed',
    'failed',
    'expired',
    'blocked',
    'scheduled',
    'unknown',
    'manual_review',
  ]),
  awaiting_chain: new Set([
    'chain_submitted',
    'processing',
    'completed',
    'failed',
    'expired',
    'blocked',
    'scheduled',
    'unknown',
    'manual_review',
  ]),
  chain_submitted: new Set([
    'processing',
    'completed',
    'failed',
    'blocked',
    'scheduled',
    'unknown',
    'manual_review',
  ]),
  processing: new Set([
    'completed',
    'failed',
    'blocked',
    'scheduled',
    'reversed',
    'unknown',
    'manual_review',
  ]),
  completed: new Set(['reversed']),
  failed: new Set(),
  expired: new Set(),
  blocked: new Set([
    'processing',
    'completed',
    'failed',
    'scheduled',
    'reversed',
    'unknown',
    'manual_review',
  ]),
  scheduled: new Set([
    'processing',
    'completed',
    'failed',
    'blocked',
    'reversed',
    'unknown',
    'manual_review',
  ]),
  reversed: new Set(),
  unknown: new Set([
    'awaiting_fiat',
    'awaiting_chain',
    'chain_submitted',
    'processing',
    'completed',
    'failed',
    'expired',
    'blocked',
    'scheduled',
    'reversed',
    'manual_review',
  ]),
  manual_review: new Set(),
}

export function canTransitionPayment(from: PaymentStatus, to: PaymentStatus): boolean {
  return from === to || allowedNext[from].has(to)
}

export function isPaymentTerminal(status: PaymentStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'expired' || status === 'reversed'
}
