import type { RequestHandler } from 'express'
import type { AuthService } from './AuthService.js'
import { AppError } from '../utils/errors.js'

export function authenticationMiddleware(authService: AuthService): RequestHandler {
  return async (request, _response, next) => {
    try {
      const authorization = request.header('authorization')
      if (!authorization?.startsWith('Bearer '))
        throw new AppError('AUTH_REQUIRED', 'Authentication required', 401)
      const token = authorization.slice('Bearer '.length).trim()
      if (!token) throw new AppError('AUTH_REQUIRED', 'Authentication required', 401)
      request.identity = await authService.authenticate(token)
      next()
    } catch (error) {
      next(error)
    }
  }
}

export function requireIdentity(request: Express.Request) {
  if (!request.identity) throw new AppError('AUTH_REQUIRED', 'Authentication required', 401)
  return request.identity
}
