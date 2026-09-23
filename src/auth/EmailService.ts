import type { Environment } from '../config/env.js'
import { logger } from '../utils/logger.js'

export type AuthEmail = {
  to: string
  purpose: 'verify_email' | 'reset_password'
  token: string
  expiresInSeconds: number
}

export interface EmailService {
  send(message: AuthEmail): Promise<void>
}

class ConsoleEmailService implements EmailService {
  send(message: AuthEmail): Promise<void> {
    logger.info('Development authentication email generated', {
      to: message.to,
      purpose: message.purpose,
      // Deliberately do not log the raw token. Tests inject a capturing provider.
      expiresInSeconds: message.expiresInSeconds,
    })
    return Promise.resolve()
  }
}

class HttpEmailService implements EmailService {
  constructor(
    private readonly url: string,
    private readonly apiKey: string,
  ) {}

  async send(message: AuthEmail): Promise<void> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`Email provider returned ${response.status}`)
  }
}

export function createEmailService(environment: Environment): EmailService {
  if (environment.AUTH_EMAIL_DELIVERY_MODE === 'http') {
    if (!environment.AUTH_EMAIL_PROVIDER_URL || !environment.AUTH_EMAIL_PROVIDER_API_KEY) {
      throw new Error('HTTP email provider is not fully configured')
    }
    return new HttpEmailService(environment.AUTH_EMAIL_PROVIDER_URL, environment.AUTH_EMAIL_PROVIDER_API_KEY)
  }
  return new ConsoleEmailService()
}
