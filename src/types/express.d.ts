import type { AuthIdentity } from '../auth/types.js'

declare global {
  namespace Express {
    interface Request {
      requestId: string
      identity?: AuthIdentity
    }
  }
}

export {}
