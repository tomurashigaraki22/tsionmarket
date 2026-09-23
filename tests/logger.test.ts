import { describe, expect, it } from 'vitest'
import Transport from 'winston-transport'
import { logger } from '../src/utils/logger.js'

// Captures whatever the logger's format pipeline produces, without depending
// on the console transport's async flush timing.
class CaptureTransport extends Transport {
  logs: Array<Record<string, unknown>> = []
  log(info: Record<string, unknown>, callback: () => void): void {
    this.logs.push(info)
    callback()
  }
}

function captureOne(run: () => void): Record<string, unknown> {
  const capture = new CaptureTransport()
  logger.add(capture)
  try {
    run()
  } finally {
    logger.remove(capture)
  }
  const [entry] = capture.logs
  if (!entry) throw new Error('logger did not emit an entry')
  return entry
}

describe('logger redaction and error expansion', () => {
  it('redacts sensitive field names regardless of nesting or casing', () => {
    const entry = captureOne(() =>
      logger.info('login attempt', {
        password: 'hunter2',
        newPassword: 'hunter3',
        currentPassword: 'hunter1',
        Authorization: 'Bearer abc123',
        cookie: 'tsion_refresh=xyz',
        otpCode: '482913',
        resetToken: 'reset-abc',
        csrfToken: 'csrf-abc',
        signedTransaction: '0xdeadbeef',
        nested: { refreshToken: 'refresh-abc', mnemonic: 'seed words here' },
        // Fields that must survive — redaction must not be so broad it
        // destroys the ability to trace a request.
        requestId: 'req-123',
        email: 'user@example.com',
      }),
    )

    expect(entry.password).toBe('[REDACTED]')
    expect(entry.newPassword).toBe('[REDACTED]')
    expect(entry.currentPassword).toBe('[REDACTED]')
    expect(entry.Authorization).toBe('[REDACTED]')
    expect(entry.cookie).toBe('[REDACTED]')
    expect(entry.otpCode).toBe('[REDACTED]')
    expect(entry.resetToken).toBe('[REDACTED]')
    expect(entry.csrfToken).toBe('[REDACTED]')
    expect(entry.signedTransaction).toBe('[REDACTED]')
    expect((entry.nested as Record<string, unknown>).refreshToken).toBe('[REDACTED]')
    expect((entry.nested as Record<string, unknown>).mnemonic).toBe('[REDACTED]')

    expect(entry.requestId).toBe('req-123')
    expect(entry.email).toBe('user@example.com')
  })

  it('expands a raw Error into message/stack rather than logging {}', () => {
    const entry = captureOne(() =>
      logger.error('unexpected failure', { error: new Error('boom') }),
    )
    const error = entry.error as Record<string, unknown>
    expect(error.message).toBe('boom')
    expect(typeof error.stack).toBe('string')
    expect((error.stack as string).length).toBeGreaterThan(0)
  })

  it('redacts a raw SQL driver error instead of logging the query text', () => {
    const dbError = new Error('Duplicate entry') as Error & {
      sql?: string
      sqlMessage?: string
    }
    dbError.sql = 'UPDATE users SET password=? WHERE email="leak@example.com"'
    dbError.sqlMessage = "Duplicate entry 'leak@example.com'"

    const entry = captureOne(() =>
      logger.error('db write failed', { error: dbError }),
    )
    const error = entry.error as Record<string, unknown>

    // The message/stack are still useful for tracing...
    expect(error.message).toBe('Duplicate entry')
    // ...but the raw query text, which can embed bound values, is not.
    expect(error.sql).toBe('[REDACTED]')
    expect(error.sqlMessage).toBe('[REDACTED]')
    expect(JSON.stringify(entry)).not.toContain('leak@example.com')
  })
})
