import mysql, { type Pool, type PoolConnection, type PoolOptions } from 'mysql2/promise'
import type { Environment } from '../config/env.js'

function basePoolOptions(environment: Environment): PoolOptions {
  return {
    host: environment.MYSQL_HOST,
    port: environment.MYSQL_PORT,
    database: environment.MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: environment.MYSQL_CONNECTION_LIMIT,
    queueLimit: environment.MYSQL_QUEUE_LIMIT,
    connectTimeout: environment.MYSQL_CONNECT_TIMEOUT_MS,
    decimalNumbers: false,
    dateStrings: true,
    timezone: 'Z',
    charset: 'utf8mb4',
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
  }
}

export function createApplicationPool(environment: Environment): Pool {
  return mysql.createPool({
    ...basePoolOptions(environment),
    user: environment.MYSQL_USER,
    password: environment.MYSQL_PASSWORD,
  })
}

export function createMigrationPool(environment: Environment): Pool {
  return mysql.createPool({
    ...basePoolOptions(environment),
    connectionLimit: 1,
    user: environment.MYSQL_MIGRATION_USER,
    password: environment.MYSQL_MIGRATION_PASSWORD,
    multipleStatements: true,
  })
}

export async function acquireConnection(pool: Pool, timeoutMs: number): Promise<PoolConnection> {
  let timedOut = false
  const acquisition = pool.getConnection()
  let timer: NodeJS.Timeout
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      reject(new Error('Timed out acquiring a database connection'))
    }, timeoutMs)
    timer.unref()
  })
  void acquisition.then(
    () => clearTimeout(timer),
    () => clearTimeout(timer),
  )

  try {
    return await Promise.race([acquisition, timeout])
  } catch (error) {
    if (timedOut) void acquisition.then((connection) => connection.release()).catch(() => undefined)
    throw error
  }
}
