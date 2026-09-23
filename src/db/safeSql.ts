import { AppError } from '../utils/errors.js'

export function allowlistedSqlValue<T extends string>(
  value: string,
  allowed: readonly T[],
  label: string,
): T {
  if (!allowed.includes(value as T)) {
    throw new AppError('INVALID_QUERY_OPTION', `Invalid ${label}`, 400)
  }
  return value as T
}
