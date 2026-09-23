import { randomUUID } from 'node:crypto'
import type { RequestHandler } from 'express'

const SAFE_REQUEST_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/

export const requestId: RequestHandler = (request, response, next) => {
  const supplied = request.header('x-request-id')
  const id = supplied && SAFE_REQUEST_ID.test(supplied) ? supplied : randomUUID()
  request.requestId = id
  response.setHeader('x-request-id', id)
  next()
}
