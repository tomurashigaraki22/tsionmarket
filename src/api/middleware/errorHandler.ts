import type { ErrorRequestHandler, RequestHandler } from 'express'
import { ZodError } from 'zod'
import { AppError } from '../../utils/errors.js'
import { logger } from '../../utils/logger.js'

export const notFound: RequestHandler = (_request, _response, next) => {
  next(new AppError('NOT_FOUND', 'Route not found', 404))
}

export const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
  const caught: unknown = error
  const normalized =
    caught instanceof AppError
      ? caught
      : caught instanceof ZodError
        ? new AppError('VALIDATION_ERROR', 'Request validation failed', 400, caught.flatten())
        : new AppError('INTERNAL_ERROR', 'An unexpected error occurred', 500)

  const context = {
    requestId: request.requestId,
    method: request.method,
    path: request.path,
    code: normalized.code,
  }
  if (normalized.statusCode >= 500) logger.error(normalized.message, { ...context, error: caught })
  else logger.warn(normalized.message, context)

  response.status(normalized.statusCode).json({
    success: false,
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(normalized.details === undefined ? {} : { details: normalized.details }),
    },
    requestId: request.requestId,
  })
}
