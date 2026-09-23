import nodemailer from 'nodemailer'
import type { Transporter } from 'nodemailer'
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

function formatDuration(seconds: number): string {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600
    return `${hours} hour${hours === 1 ? '' : 's'}`
  }
  const minutes = Math.round(seconds / 60)
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}

const COPY = {
  verify_email: {
    subject: 'Confirm your TsionMarket email',
    heading: 'Confirm your email',
    body: 'Use the link below to confirm this address and finish setting up your account.',
    action: 'Confirm email',
    path: '/verify-email',
  },
  reset_password: {
    subject: 'Reset your TsionMarket password',
    heading: 'Reset your password',
    body: 'Use the link below to choose a new password. If you did not request this, you can ignore this email and nothing will change.',
    action: 'Reset password',
    path: '/reset-password',
  },
} as const

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

class SmtpEmailService implements EmailService {
  private readonly transporter: Transporter

  constructor(
    private readonly from: string,
    private readonly linkBaseUrl: string,
    options: {
      host: string
      port: number
      secure: boolean
      user: string
      password: string
    },
  ) {
    this.transporter = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure,
      auth: { user: options.user, pass: options.password },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    })
  }

  async send(message: AuthEmail): Promise<void> {
    const copy = COPY[message.purpose]
    const link = new URL(copy.path, this.linkBaseUrl)
    link.searchParams.set('token', message.token)
    const href = link.toString()
    const expiry = formatDuration(message.expiresInSeconds)

    const text = [
      copy.heading,
      '',
      copy.body,
      '',
      href,
      '',
      `This link expires in ${expiry}.`,
    ].join('\n')

    const safeHref = escapeHtml(href)
    const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f5f3ee;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#101012">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;padding:32px">
    <h1 style="margin:0 0 16px;font-size:20px">${escapeHtml(copy.heading)}</h1>
    <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#44444a">${escapeHtml(copy.body)}</p>
    <a href="${safeHref}" style="display:inline-block;background:#101012;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:999px;font-size:15px">${escapeHtml(copy.action)}</a>
    <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#74726b">
      This link expires in ${escapeHtml(expiry)}. If the button does not work, paste this into your browser:<br>
      <span style="word-break:break-all">${safeHref}</span>
    </p>
  </div>
</body></html>`

    await this.transporter.sendMail({
      from: this.from,
      to: message.to,
      subject: copy.subject,
      text,
      html,
    })
  }
}

export function createEmailService(environment: Environment): EmailService {
  if (environment.AUTH_EMAIL_DELIVERY_MODE === 'http') {
    if (!environment.AUTH_EMAIL_PROVIDER_URL || !environment.AUTH_EMAIL_PROVIDER_API_KEY) {
      throw new Error('HTTP email provider is not fully configured')
    }
    return new HttpEmailService(
      environment.AUTH_EMAIL_PROVIDER_URL,
      environment.AUTH_EMAIL_PROVIDER_API_KEY,
    )
  }

  if (environment.AUTH_EMAIL_DELIVERY_MODE === 'smtp') {
    const { AUTH_SMTP_HOST, AUTH_SMTP_USER, AUTH_SMTP_PASSWORD, AUTH_EMAIL_FROM, AUTH_EMAIL_LINK_BASE_URL } =
      environment
    if (
      !AUTH_SMTP_HOST ||
      !AUTH_SMTP_USER ||
      !AUTH_SMTP_PASSWORD ||
      !AUTH_EMAIL_FROM ||
      !AUTH_EMAIL_LINK_BASE_URL
    ) {
      throw new Error('SMTP email delivery is not fully configured')
    }
    return new SmtpEmailService(AUTH_EMAIL_FROM, AUTH_EMAIL_LINK_BASE_URL, {
      host: AUTH_SMTP_HOST,
      port: environment.AUTH_SMTP_PORT,
      secure: environment.AUTH_SMTP_SECURE,
      user: AUTH_SMTP_USER,
      password: AUTH_SMTP_PASSWORD,
    })
  }

  return new ConsoleEmailService()
}
