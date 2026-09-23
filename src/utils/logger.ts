import winston from 'winston'

// Substring, case-insensitive: catches `newPassword`, `currentPassword`,
// `resetToken`, `csrfToken`, `x-csrf-token`, `otpCode`, etc. without needing
// to enumerate every field name a future schema might add.
const REDACTED_KEY_PATTERNS = [
  /authoriz/i,
  /cookie/i,
  /password/i,
  /token/i,
  /secret/i,
  /otp/i,
  /privatekey/i,
  /seedphrase/i,
  /mnemonic/i,
  /passphrase/i,
  // A raw DB driver error can attach the literal query text (mysql2 sets
  // `.sql`/`.sqlMessage` as own enumerable properties), which may embed bound
  // values such as an email or token. Treated as sensitive, not logged.
  /^sql/i,
  // A signed transaction is the exact bytes a user authorized — logging it
  // verbatim is unnecessary and a support ticket has no legitimate use for it.
  /signedtransaction/i,
]

function isSensitiveKey(key: string): boolean {
  return REDACTED_KEY_PATTERNS.some((pattern) => pattern.test(key))
}

/**
 * `Error` instances serialize to `{}` under JSON.stringify — `message` and
 * `stack` are non-enumerable — so an error logged as `{ error: caught }`
 * previously vanished entirely except for any custom properties a thrower
 * happened to attach (see the `sql` case above). This expands an Error into
 * a plain object so there is something to read (and to redact) at all.
 */
function expandErrors(value: unknown): unknown {
  if (value instanceof Error) {
    const expanded: Record<string, unknown> = {
      name: value.name,
      message: value.message,
      stack: value.stack,
    }
    for (const key of Object.keys(value)) expanded[key] = (value as never)[key]
    return expandErrors(expanded)
  }
  if (Array.isArray(value)) return value.map(expandErrors)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, expandErrors(entry)]),
    )
  }
  return value
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        isSensitiveKey(key) ? '[REDACTED]' : redact(entry),
      ]),
    )
  }
  return value
}

/**
 * Winston's `info` object carries internal state as own Symbol properties
 * (`Symbol.for('level')` and friends), which `Object.entries`/`fromEntries`
 * silently drop because they only see string keys. Rebuilding `info` itself
 * — as opposed to a plain value nested inside it — therefore produces an
 * object winston can no longer route to any transport, with no error thrown.
 * So the top-level transform mutates known string-keyed properties in place
 * and returns the same `info` reference; only values nested underneath are
 * safe to rebuild via the pure helpers above.
 */
function expandErrorsTopLevel(
  info: winston.Logform.TransformableInfo,
): winston.Logform.TransformableInfo {
  for (const key of Object.keys(info)) {
    ;(info as Record<string, unknown>)[key] = expandErrors(
      (info as Record<string, unknown>)[key],
    )
  }
  return info
}

function redactTopLevel(
  info: winston.Logform.TransformableInfo,
): winston.Logform.TransformableInfo {
  for (const key of Object.keys(info)) {
    // A top-level key can itself be sensitive (e.g. logger.error(msg, {
    // password: '...' })), which redact()'s nested-object check alone would
    // miss — it only inspects keys one level inside whatever value it's given.
    ;(info as Record<string, unknown>)[key] = isSensitiveKey(key)
      ? '[REDACTED]'
      : redact((info as Record<string, unknown>)[key])
  }
  return info
}

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  format: winston.format.combine(
    winston.format(expandErrorsTopLevel)(),
    winston.format(redactTopLevel)(),
    winston.format.timestamp(),
    winston.format.json(),
  ),
  transports: [new winston.transports.Console()],
})
