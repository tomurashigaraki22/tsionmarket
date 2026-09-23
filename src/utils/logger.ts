import winston from 'winston'

const REDACTED_KEYS = new Set([
  'authorization',
  'cookie',
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'privateKey',
  'seedPhrase',
  'secret',
])

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        REDACTED_KEYS.has(key) ? '[REDACTED]' : redact(entry),
      ]),
    )
  }
  return value
}

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  format: winston.format.combine(
    winston.format((info) => redact(info) as winston.Logform.TransformableInfo)(),
    winston.format.timestamp(),
    winston.format.json(),
  ),
  transports: [new winston.transports.Console()],
})
